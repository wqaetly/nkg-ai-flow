# Advisor Demo

这个 app 展示 Advisor 是 **Run 级可选能力**，而不是塞进业务图的固定节点：

- `primary.flow.ts` 是普通业务 Flow，只包含风险事实与受保护动作；
- `reviewer.flow.ts` 是普通 Advisor Flow，消费目标 Run 的增量 `NodeEvent`；
- `runtime.ts` 用 `AdvisorRuntime` 把两条 Flow 绑定，启用 `gate` 模式；
- 高风险产生 `blocker`，Runtime 在下一个节点边界进入 `suspended`，调用 `resume()` 后继续。

构建 Flow Artifact：

```bash
npm run build -w @ai-native-flow/advisor-demo
```

运行高风险暂停/恢复演示：

```bash
npm run demo -w @ai-native-flow/advisor-demo -- high
```

也可以传入 `medium` 或 `low`，分别观察 guidance 注入与无建议路径。
