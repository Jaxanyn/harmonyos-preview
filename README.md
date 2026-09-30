# harmonyos-preview
面向 AI 编程 Agent 的 HarmonyOS 真机与模拟器实时预览及交互插件。

## 当前状态

第 2 步已建立最小本地 Preview Host。当前只提供回环地址上的健康检查，不连接设备、不修改 HarmonyOS 工程。

## 开发

```powershell
npm run check
npm start
```

启动后访问 `http://127.0.0.1:4100/health`。
