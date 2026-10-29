import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import WebSocket from 'ws';
import { createPreviewServer } from '../src/server.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const captures = [];
const lists = [];
const adapter = {
  capture: (options) => {
    const pending = deferred();
    captures.push({ ...pending, options });
    return pending.promise;
  },
  listTargets: () => {
    const pending = deferred();
    lists.push(pending);
    return pending.promise;
  }
};
const server = createPreviewServer({ deviceAdapter: adapter });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
let socket;
const events = [];

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for server event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function drain() {
  await nextTurn();
  await new Promise((resolve) => { socket.once('pong', resolve); socket.ping(); });
}
const send = (action) => socket.send(JSON.stringify(action));
const frame = (text) => ({ mimeType: 'image/jpeg', data: Buffer.from(text), frameId: text, width: 1440, height: 3120, capturedAt: 123 });
const stopped = async () => {
  const count = events.filter((event) => event.type === 'preview-status' && !event.running && !event.deviceId).length;
  send({ type: 'preview-stop' });
  await waitFor(() => events.filter((event) => event.type === 'preview-status' && !event.running && !event.deviceId).length > count);
};

try {
  for (const body of [
    { deviceId: 'A', directory: '../outside' },
    { deviceId: 'A', fileName: '../important.txt' },
    { deviceId: 'A', surprise: true }, null, [], { deviceId: '' }
  ]) {
    const response = await fetch(`${address}/api/capture`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /capture|deviceId/);
  }
  assert.equal(captures.length, 0, 'invalid HTTP screenshot parameters must not reach the adapter');

  socket = new WebSocket(address.replace('http:', 'ws:') + '/preview');
  socket.on('message', (message, isBinary) => events.push(isBinary ? { binary: message.toString() } : JSON.parse(message.toString())));
  await waitFor(() => events.length === 3);
  for (const option of ['directory', 'fileName', 'surprise']) {
    const previous = events.length;
    send({ type: 'screenshot', deviceId: 'A', [option]: '../outside' });
    await waitFor(() => events.length > previous);
    assert.match(events.at(-1).error, /unsupported capture parameter/);
  }
  assert.equal(captures.length, 0, 'invalid WebSocket screenshot parameters must not reach the adapter');

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 1);
  assert.deepEqual(captures[0].options, { deviceId: 'A' });
  await stopped();
  let boundary = events.length;
  captures[0].resolve(frame('stopped-A'));
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'a stopped polling capture must emit neither frame nor tick');

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 2);
  send({ type: 'preview-start', deviceId: 'B' });
  await waitFor(() => captures.length === 3);
  captures[2].resolve(frame('current-B'));
  await waitFor(() => events.some((event) => event.binary === 'current-B'));
  assert.deepEqual(events.find((event) => event.type === 'frame-meta' && event.deviceId === 'B'), {
    type: 'frame-meta', mimeType: 'image/jpeg', deviceId: 'B', source: 'preview', frameId: 'current-B', capturedAt: 123, width: 1440, height: 3120
  });
  boundary = events.length;
  captures[1].resolve(frame('old-A'));
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'switching devices must suppress the old capture and tick');
  await stopped();

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 4);
  await stopped();
  boundary = events.length;
  captures[3].reject(new Error('late capture failure'));
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'a late capture error must not report disconnection after stop');
  assert.equal(lists.length, 0, 'a stopped capture must not begin device discovery');

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 5);
  captures[4].reject(new Error('disconnected'));
  await waitFor(() => lists.length === 1);
  const failedCapture = events.findLast((event) => event.type === 'preview-status' && event.diagnostic);
  assert.equal(failedCapture.reason, 'capture-failed', 'an error string alone must not establish that the device is offline');
  assert.equal(failedCapture.diagnostic.errorCode, 'CAPTURE_FAILED');
  assert.equal(failedCapture.diagnostic.deviceId, 'A');
  await stopped();
  boundary = events.length;
  lists[0].resolve(['A']);
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'discovery that completes after stop must not report stale devices');

  send({ type: 'screenshot', deviceId: 'A' });
  await waitFor(() => captures.length === 6);
  await stopped();
  boundary = events.length;
  captures[5].resolve(frame('old-manual-capture'));
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'stop must invalidate an in-flight manual screenshot too');

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 7);
  await new Promise((resolve) => setTimeout(resolve, 600));
  captures[6].resolve(frame('same-reconnected-frame'));
  await waitFor(() => events.some((event) => event.binary === 'same-reconnected-frame'));
  // A slow capture must not add another full poll period after it completes.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(captures.length, 8, 'the next preview capture starts as soon as the prior capture completes');
  await waitFor(() => captures.length === 8);
  captures[7].reject(new Error('disconnected again'));
  await waitFor(() => lists.length === 2);
  boundary = events.length;
  lists[1].resolve(['A']);
  await waitFor(() => captures.length === 9);
  captures[8].resolve(frame('same-reconnected-frame'));
  await waitFor(() => events.filter((event) => event.binary === 'same-reconnected-frame').length === 2);
  const recoveryEvents = events.slice(boundary);
  const recovered = recoveryEvents.findIndex((event) => event.type === 'preview-status' && event.running && event.reconnecting === false);
  const recoveredFrame = recoveryEvents.findIndex((event) => event.type === 'frame-meta');
  assert.ok(recovered >= 0 && recovered < recoveredFrame, 'successful sampling must announce recovery before sending the fresh frame');
  await stopped();

  // An action-triggered refresh must publish a new sequence even when pixels are unchanged.
  const refreshCaptureCount = captures.length;
  const refreshFrameCount = events.filter((event) => event.binary === 'refresh-same').length;
  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === refreshCaptureCount + 1);
  captures.at(-1).resolve(frame('refresh-same'));
  await waitFor(() => events.filter((event) => event.binary === 'refresh-same').length === refreshFrameCount + 1);
  send({ type: 'preview-refresh', deviceId: 'A' });
  await waitFor(() => captures.length === refreshCaptureCount + 2);
  captures.at(-1).resolve(frame('refresh-same'));
  await waitFor(() => events.filter((event) => event.binary === 'refresh-same').length === refreshFrameCount + 2);
  await stopped();

  const page = await (await fetch(address)).text();
  verifyBrowserFrameLifecycle(page);
} finally {
  socket?.terminate();
  await server.shutdown();
}

function verifyBrowserFrameLifecycle(page) {
  const elements = Object.fromEntries(['stage', 'status', 'devices', 'refresh', 'build', 'shot', 'start', 'stop']
    .map((id) => [id, { style: {}, src: '', value: '', textContent: '', replaceChildren() {}, removeAttribute(name) { this[name] = ''; } }]));
  const stage = elements.stage;
  stage.naturalWidth = 1440;
  stage.naturalHeight = 3120;
  const displayBox = { left: 0, top: 0, width: 360, height: 780 };
  stage.getBoundingClientRect = () => ({ ...displayBox });
  const images = [], sent = [], timers = new Map(), revoked = [];
  let client, urlId = 0, timerId = 0;
  class BrowserSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { client = this; }
    send(value) { sent.push(JSON.parse(value)); }
  }
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { querySelector: (selector) => elements[selector.slice(1)] },
    location: { search: '?deviceId=A', protocol: 'http:', host: '127.0.0.1:4100' },
    URLSearchParams, Blob, WebSocket: BrowserSocket,
    URL: { createObjectURL: () => `blob:${++urlId}`, revokeObjectURL: (url) => revoked.push(url) },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    Image: class { constructor() { images.push(this); } },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id)
  });
  const receive = (message) => client.onmessage({ data: JSON.stringify(message) });
  const queueImage = (deviceId, source = 'capture') => {
    receive({ type: 'frame-meta', mimeType: 'image/jpeg', deviceId, source });
    client.onmessage({ data: Buffer.from('image') });
    return images.at(-1);
  };
  const paint = (deviceId) => { queueImage(deviceId).onload(); stage.onload(); };
  const pointer = { clientX: 100, clientY: 200, pointerId: 1 };
  const tap = () => { stage.onpointerdown(pointer); stage.onpointerup(pointer); };
  const assertDisabled = () => {
    const previous = sent.length;
    tap();
    assert.equal(sent.length, previous, 'an invalid frame must not send a gesture');
    assert.equal(stage.style.pointerEvents, 'none');
    assert.equal(stage.hidden, true, 'invalidated images must stay hidden instead of showing a broken image');
  };

  client.onopen();
  receive({ type: 'devices', devices: ['A', 'B'] });
  assert.equal(sent.at(-1).type, 'preview-start');
  paint('A');
  assert.equal(stage.hidden, false, 'only a successfully loaded current image becomes visible');
  tap();
  assert.deepEqual(sent.at(-1), { type: 'tap', deviceId: 'A', x: 400, y: 800 }, 'coordinates must use actual screenshot dimensions');
  assertDisabled();
  receive({ type: 'tap-ack', deviceId: 'A' });
  assert.deepEqual(sent.at(-1), { type: 'screenshot', deviceId: 'A' }, 'an acknowledged action must request a verification screenshot');

  let imageCount = images.length;
  queueImage('A', 'preview');
  assert.equal(images.length, imageCount, 'a preview captured before the action must not satisfy its verification screenshot');
  assertDisabled();
  const verifiedImage = queueImage('A', 'capture');
  imageCount = images.length;
  queueImage('A', 'preview');
  assert.equal(images.length, imageCount, 'preview frames must not replace a manual screenshot while it is still decoding');
  verifiedImage.onload();
  stage.onload();
  assert.equal(stage.hidden, false);
  queueImage('A', 'preview').onload();
  stage.onload();
  assert.equal(stage.style.pointerEvents, 'auto', 'live preview must resume after the verification screenshot is loaded');

  paint('A');
  receive({ type: 'preview-status', running: false, deviceId: 'A', reason: 'device-disconnected', reconnecting: true });
  assertDisabled();
  receive({ type: 'devices', devices: [] });
  imageCount = images.length;
  queueImage('A');
  assert.equal(images.length, imageCount, 'a frame alone must not restore interaction before recovery is confirmed');
  receive({ type: 'preview-status', running: true, deviceId: 'A', reconnecting: false });
  paint('A');
  assert.equal(stage.style.pointerEvents, 'auto', 'a fresh frame must restore the selected device after reconnect');

  elements.shot.onclick();
  const pendingImage = queueImage('A');
  elements.devices.value = 'B';
  elements.devices.onchange();
  pendingImage.onload();
  assert.equal(stage.src, '', 'an old image load must not restore the previous device frame');
  assertDisabled();

  elements.shot.onclick();
  paint('B');
  const staleLoad = stage.onload;
  elements.stop.onclick();
  staleLoad();
  assertDisabled();
  imageCount = images.length;
  queueImage('B');
  assert.equal(images.length, imageCount, 'stopped preview must discard incoming frames');

  elements.start.onclick();
  paint('B');
  receive({ type: 'error', error: 'capture failed' });
  assertDisabled();
  imageCount = images.length;
  queueImage('B');
  receive({ type: 'preview-status', running: true, deviceId: 'B', reconnecting: false });
  queueImage('B');
  assert.equal(images.length, imageCount, 'generic errors must require a new capture or preview request instead of accepting late frames or recovery status');

  for (const phase of ['pointerup', 'long-press']) {
    elements.shot.onclick();
    paint('B');
    stage.onpointerdown(pointer);
    const beforeRotation = sent.length;
    stage.naturalWidth = 3120;
    stage.naturalHeight = 1440;
    if (phase === 'pointerup') stage.onpointerup(pointer);
    else [...timers.values()].forEach((callback) => callback());
    assert.equal(sent.length, beforeRotation, `${phase} must not combine coordinates across a screen rotation`);
    assertDisabled();
    stage.naturalWidth = 1440;
    stage.naturalHeight = 3120;
  }
  elements.shot.onclick();
  paint('B');
  stage.onpointerdown(pointer);
  const beforeResize = sent.length;
  displayBox.width = 400;
  stage.onpointerup(pointer);
  assert.equal(sent.length, beforeResize, 'resizing the displayed image must invalidate a gesture in progress');
  assertDisabled();
  displayBox.width = 360;

  elements.shot.onclick();
  paint('B');
  stage.onpointerdown(pointer);
  assert.equal(timers.size, 1);
  client.readyState = 3;
  client.onclose();
  assert.equal(timers.size, 0, 'disconnect must cancel an in-progress long press');
  assertDisabled();
  assert.ok(revoked.length > 0, 'discarded screenshot URLs must be released');
}

console.log('server races: ok');
