# A2UI 试用提示词

启动好前后端后，在左侧输入框尝试以下提示词，观察右侧 Surface 区域的渐进式渲染。

## 1. 基本卡片
```
做一个欢迎卡片，标题"你好，A2UI"，下面写一段简短介绍。
```

## 2. 联系表单（含校验）
```
给我一个联系表单，包含姓名、邮箱、留言三个字段，以及一个"发送"按钮。
邮箱必须合法，留言至少 10 个字。提交时触发 submitContact 事件。
```
- 故意输入非法邮箱 → 按钮变灰，错误提示出现
- 修正后点击 → 服务端收到 action，回推下一个 surface

## 3. 列表模板（ChildList 迭代）
```
推荐 5 本经典科幻小说，做成卡片列表。每张卡片显示书名、作者、一句简介。
用 ChildList 模板，把数据放在 /books。
```

## 4. 设置面板（多输入 + Slider）
```
做一个设置面板：暗色模式开关、字号 slider (12~24)、主题色选择器（红/绿/蓝）。
不需要提交按钮，状态保留在本地 dataModel 即可。
```

## 5. 本地 action：openUrl
```
做一个"友情链接"卡片，里面三个按钮分别打开 https://a2ui.org、
https://react.dev、https://fastify.dev，使用 openUrl 本地函数。
```

## 6. Tabs 多页
```
做一个三标签面板：标签 1 是欢迎语，标签 2 是 FAQ（3 条），标签 3 是反馈表单。
```

## 7. Modal 弹窗
```
做一个主界面：一个按钮"打开详情"。
点击后通过 dataModel 切换 /uiState/modalOpen，弹出 Modal 显示一些内容。
```

## 8. formatString 格式化
```
做一个用户欢迎卡片，data model 里有 user.firstName="Alice"、loginCount=42。
正文用 formatString 渲染："Hi ${/user/firstName}, 这是你第 ${/loginCount} 次登录。"
```

## 9. 复合 action（带 sendDataModel）
```
做一个调查问卷：包含 3 道单选题、一个"提交"按钮。
surface 创建时设 sendDataModel:true。提交时触发 submitSurvey，
服务端会看到当前 dataModel 并基于答案生成"结果卡片"。
```
