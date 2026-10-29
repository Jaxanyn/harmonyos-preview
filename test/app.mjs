import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/app/main.mjs', import.meta.url), 'utf8');
const flush = async () => { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); };
const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
let nextFrameSeq = 0;
const imageResult = (deviceId, width = 1260, height = 2720) => ({
  content: [],
  structuredContent: { deviceId, connected: true, sessionId: 'test-session', seq: ++nextFrameSeq,
    metrics: { source: 'jpeg', captureMs: 42, frameBytes: 1234, capturedAt: new Date().toISOString() },
    frame: { mimeType: 'image/png', data: `${width}x${height}`, frameId: `frame-${nextFrameSeq}`, capturedAt: new Date().toISOString(), width, height } },
});

function createPanel() {
  class Element {
    listeners = new Map();
    value = '';
    src = '';
    naturalWidth = 0;
    naturalHeight = 0;
    textContent = '';
    className = '';
    style = {};
    disabled = false;
    hidden = true;
    box = { left: 10, top: 20, width: 315, height: 680 };
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    dispatch(name, event = {}) { this.listeners.get(name)?.(event); }
    replaceChildren(...children) { this.children = children; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    getBoundingClientRect() { return this.box; }
    setPointerCapture() {}
    requestFullscreen() { return Promise.resolve(); }
    async decode() {
      const source = this.src;
      if (this.decodeGate) await this.decodeGate;
      const dimensions = source.split(',').at(-1).split('x').map(Number);
      this.naturalWidth = dimensions[0];
      this.naturalHeight = dimensions[1];
    }
  }
  const elements = Object.fromEntries(['status', 'devices', 'stage', 'frame-shell', 'stage-overlay', 'overlay-text', 'gesture-marker', 'metrics',
    'refresh', 'build', 'start', 'stop', 'fit', 'zoom-out', 'zoom-in', 'fullscreen'].map((id) => [id, new Element()]));
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  const windowListeners = new Map();
  const parent = { postMessage(message) { sent.push(message); } };
  const context = vm.createContext({
    window: { parent, addEventListener(name, listener) { windowListeners.set(name, listener); } },
    document: {
      querySelector: (selector) => elements[selector.slice(1)],
      querySelectorAll: () => ['refresh', 'build', 'start', 'stop', 'fit', 'zoom-out', 'zoom-in', 'fullscreen'].map((id) => elements[id]),
      documentElement: { style: { setProperty() {} } },
      fullscreenElement: null,
    },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context, { filename: 'src/app/main.mjs' });
  const take = (name) => {
    const index = sent.findIndex((message) => name === 'ui/initialize' ? message.method === name : message.method === 'tools/call' && message.params.name === name);
    assert.notEqual(index, -1, `Missing request: ${name}`);
    return sent.splice(index, 1)[0];
  };
  const reply = async (request, result) => {
    windowListeners.get('message')({ source: parent, data: { jsonrpc: '2.0', id: request.id, result } });
    await flush();
  };
  const runPoll = async () => {
    const timer = [...timers].find(([, value]) => value.ms === 500);
    assert.ok(timer, 'A completed preview frame should schedule the next poll');
    timers.delete(timer[0]);
    timer[1].callback();
    await flush();
  };
  const runTimer = async (ms) => {
    const timer = [...timers].find(([, value]) => value.ms === ms);
    assert.ok(timer, `A ${ms}ms timer should be scheduled`);
    timers.delete(timer[0]);
    timer[1].callback();
    await flush();
  };
  const clickImage = (x, y) => {
    elements.stage.dispatch('pointerdown', { clientX: x, clientY: y, pointerId: 1 });
    elements.stage.dispatch('pointerup', { clientX: x, clientY: y, pointerId: 1 });
  };
  return { elements, sent, timers, windowListeners, parent, take, reply, runPoll, runTimer, clickImage };
}

async function readyPanel() {
  const panel = createPanel();
  await panel.reply(panel.take('ui/initialize'), { hostContext: {} });
  await panel.reply(panel.take('list_devices'), textResult({ devices: ['A', 'B'] }));
  assert.equal(panel.elements.devices.value, 'A');
  assert.equal(panel.elements.stage.hidden, true, 'Hide the image until the first valid frame');
  return panel;
}

async function start(panel, id = 'A', width = 1260, height = 2720) {
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: `session-${id}`, deviceId: id, pollMs: 500 }));
  await panel.reply(panel.take('preview_frame'), imageResult(id, width, height));
  assert.equal(panel.elements.stage.hidden, false, 'Show the decoded frame');
  assert.equal(panel.elements['stage-overlay'].hidden, true, 'Hide the overlay after the first frame');
  assert.match(panel.elements.metrics.textContent, new RegExp(`${width}×${height}`));
  assert.match(panel.elements.metrics.textContent, /42ms · jpeg/);
  assert.match(panel.elements.metrics.textContent, /render \d+ms/);
}

// Only decoded image dimensions determine tap coordinates, including rotated screens and edge clamping.
{
  const panel = await readyPanel();
  panel.clickImage(167.5, 360);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'No gestures before the first frame');
  await start(panel);
  panel.clickImage(167.5, 360);
  await flush();
  assert.equal(panel.elements['gesture-marker'].hidden, false, 'Show a marker for a tap gesture');
  const tap = panel.take('preview_action');
  assert.equal(tap.params.arguments.x, 630);
  assert.equal(tap.params.arguments.y, 1360);
  panel.clickImage(167.5, 360);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Do not repeat an in-flight gesture');
  await panel.reply(tap, textResult({}));
  await panel.reply(panel.take('preview_frame'), imageResult('A', 2720, 1260));
  panel.elements.stage.box = { left: 10, top: 20, width: 680, height: 315 };
  panel.clickImage(350, 177.5);
  await flush();
  const rotated = panel.take('preview_action');
  assert.equal(rotated.params.arguments.x, 1360);
  assert.equal(rotated.params.arguments.y, 630);
  await panel.reply(rotated, textResult({}));
  await panel.reply(panel.take('preview_frame'), imageResult('A', 2720, 1260));
  panel.clickImage(1000, 900);
  await flush();
  const edge = panel.take('preview_action');
  assert.equal(edge.params.arguments.x, 2719);
  assert.equal(edge.params.arguments.y, 1259);
  await panel.reply(edge, textResult({}));
  await panel.reply(panel.take('preview_frame'), imageResult('A', 2720, 1260));
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  panel.elements.stage.dispatch('pointercancel');
  panel.elements.stage.dispatch('pointerup', { clientX: 100, clientY: 100, pointerId: 1 });
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Cancelled pointers must not act');
}

// Polling has one in-flight capture; device switches reject old responses and require a new device frame.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const oldCapture = panel.take('preview_frame');
  assert.equal([...panel.timers.values()].filter(({ ms }) => ms === 500).length, 0, 'No next poll while capture is pending');
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  assert.equal(panel.elements.stage.src, '');
  assert.equal(panel.elements.stage.hidden, true, 'Hide the image while switching devices');
  const oldStop = panel.take('preview_stop');
  assert.equal(oldStop.params.arguments.sessionId, 'session-A');
  panel.clickImage(100, 100);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'session-B', deviceId: 'B', pollMs: 500 }));
  await panel.reply(oldCapture, imageResult('A'));
  assert.equal(panel.elements.stage.src, '', 'Late frame from A must not render for B');
  const newCapture = panel.take('preview_frame');
  assert.equal(newCapture.params.arguments.afterSeq, 0);
  await panel.reply(newCapture, imageResult('B', 1600, 2560));
  await panel.reply(oldStop, textResult({ running: false }));
  panel.clickImage(167.5, 360);
  await flush();
  assert.equal(panel.take('preview_action').params.arguments.action, 'tap');
}

// After an action, wait for the first newer live frame instead of polling a stale seq.
{
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(167.5, 360);
  await flush();
  const action = panel.take('preview_action');
  await panel.reply(action, textResult({}));
  const fresh = panel.take('preview_frame');
  assert.equal(fresh.params.arguments.waitMs, 2500, 'Action refresh should wait for a newer frame');
  await panel.reply(fresh, imageResult('A', 1260, 2720));
  assert.equal(panel.elements.stage.hidden, false, 'Render the first frame available after an action');
}

// Rotation between pointer down/up, or while waiting for a capture, must cancel old-geometry gestures.
for (const rotateBeforeRelease of [true, false]) {
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const capture = panel.take('preview_frame');
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  if (rotateBeforeRelease) await panel.reply(capture, imageResult('A', 2720, 1260));
  panel.elements.stage.dispatch('pointerup', { clientX: 101, clientY: 101, pointerId: 1 });
  if (!rotateBeforeRelease) await panel.reply(capture, imageResult('A', 2720, 1260));
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'A geometry change must cancel the gesture');
}

// A late image decode from the old generation must neither enable interaction nor overwrite the new frame.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  let releaseDecode;
  panel.elements.stage.decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
  await panel.reply(panel.take('preview_frame'), imageResult('A', 900, 1800));
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'session-B', deviceId: 'B', pollMs: 500 }));
  panel.elements.stage.decodeGate = undefined;
  releaseDecode();
  await flush();
  assert.equal(panel.elements.stage.src, '', 'Old decoded image must remain invalid after switching devices');
  await panel.reply(panel.take('preview_frame'), imageResult('B', 1600, 2560));
  assert.match(panel.elements.stage.src, /1600x2560$/);
  panel.clickImage(167.5, 360);
  await flush();
  const tap = panel.take('preview_action');
  assert.equal(tap.params.arguments.action, 'tap');
  assert.equal(tap.params.arguments.x, 800);
  assert.equal(tap.params.arguments.y, 1280);
}

// Offline and mismatched frames clear interaction; polling recovers only after a valid decoded frame.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), { isError: true, content: [{ type: 'text', text: 'device disconnected' }] });
  assert.equal(panel.elements.stage.src, '');
  assert.equal(panel.elements.stage.hidden, true, 'Hide disconnected image instead of showing a broken-image placeholder');
  assert.match(panel.elements['overlay-text'].textContent, /disconnected/i);
  assert.match(panel.elements.status.textContent, /disconnected/);
  panel.clickImage(100, 100);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('B'));
  assert.equal(panel.elements.stage.src, '', 'Wrong device metadata must not render');
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.ok(panel.elements.stage.src.startsWith('data:'));
  assert.equal(panel.elements.stage.hidden, false, 'Show the image after a valid recovery frame');
  panel.clickImage(100, 100);
  await flush();
  assert.equal(panel.take('preview_action').params.arguments.action, 'tap');
}

// Stopping or removing the active device invalidates in-flight frame responses.
for (const action of ['stop', 'remove']) {
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const lateCapture = panel.take('preview_frame');
  if (action === 'stop') panel.elements.stop.dispatch('click');
  else {
    panel.elements.refresh.dispatch('click');
    await panel.reply(panel.take('list_devices'), textResult({ devices: [] }));
    assert.equal(panel.elements.devices.value, '');
  }
  await panel.reply(lateCapture, imageResult('A'));
  assert.equal(panel.elements.stage.src, '');
  assert.equal(panel.elements.stage.hidden, true, 'Hide stopped or removed device images');
  assert.equal([...panel.timers.values()].filter(({ ms }) => ms === 500).length, 0);
  panel.clickImage(100, 100);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// Host teardown stops the known session, clears timers and acknowledges the lifecycle request.
{
  const panel = await readyPanel();
  await start(panel);
  panel.windowListeners.get('message')({ source: panel.parent, data: { jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' } });
  await flush();
  assert.equal(panel.take('preview_stop').params.arguments.sessionId, 'session-A');
  assert.equal(panel.elements.stage.src, '');
  assert.equal(panel.timers.size, 0);
  assert.ok(panel.sent.some((message) => message.id === 'teardown' && message.result));
}

// Display controls change presentation only and do not alter the decoded frame dimensions.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements['zoom-in'].dispatch('click');
  assert.equal(panel.elements.stage.style.transform, 'scale(1.25)');
  panel.elements.fit.dispatch('click');
  assert.equal(panel.elements.stage.style.transform, '');
}

console.log('app: ok');
