/**
 * A2UI 组件示例 — 静态 fixture 脚本。
 *
 * 每个 demo 是一段按真实流式输出拆分出来的 A2UI 信封序列。回放引擎把它们
 * 逐条 applyEnvelope 到 store，从而把"渐进式渲染"原汁原味地放映出来：
 * 前向引用会先显示占位符，数据/组件到达后再填充。
 *
 * 严格遵循 v0.9.1 协议：
 *   - checks 用 { call, args:{ value:{path} }, message }
 *   - action 用 { event:{ name, context } } 或 { functionCall:{ call, args } }
 */

import {
  A2UI_VERSION,
  BASIC_CATALOG_ID,
  type A2UIEnvelope,
} from "@a2ui/protocol";

/** 组装一条信封，自动带上 version。 */
function env(partial: Omit<A2UIEnvelope, "version">): A2UIEnvelope {
  return { version: A2UI_VERSION, ...partial };
}

export interface GalleryDemo {
  id: string;
  name: string;
  description: string;
  category: string;
  surfaceId: string;
  envelopes: A2UIEnvelope[];
}

/* ============================================================ *
 * 1. 基础卡片 —— 渐进式出现，占位符 → 填充
 * ============================================================ */
const basicCard: A2UIEnvelope[] = [
  env({ createSurface: { surfaceId: "g_card", catalogId: BASIC_CATALOG_ID } }),
  env({
    updateComponents: {
      surfaceId: "g_card",
      components: [{ id: "root", component: "Card", child: "col" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_card",
      components: [
        {
          id: "col",
          component: "Column",
          children: ["title", "intro", "divider", "caption"],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_card",
      components: [
        { id: "title", component: "Text", variant: "heading", text: "你好，A2UI" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_card",
      components: [
        {
          id: "intro",
          component: "Text",
          text: "这张卡片是由一组 JSON 信封逐条回放出来的，左侧放映带会同步高亮当前帧。",
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_card",
      components: [{ id: "divider", component: "Divider" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_card",
      components: [
        {
          id: "caption",
          component: "Text",
          variant: "caption",
          text: "v0.9.1 · basic catalog",
        },
      ],
    },
  }),
];

/* ============================================================ *
 * 2. 联系表单（校验）—— 输入双向绑定，按钮随校验禁用
 * ============================================================ */
const contactForm: A2UIEnvelope[] = [
  env({ createSurface: { surfaceId: "g_form", catalogId: BASIC_CATALOG_ID } }),
  env({
    updateDataModel: {
      surfaceId: "g_form",
      path: "/",
      value: { name: "", email: "", message: "" },
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_form",
      components: [{ id: "root", component: "Card", child: "col" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_form",
      components: [
        {
          id: "col",
          component: "Column",
          children: ["title", "name", "email", "message", "submit"],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_form",
      components: [
        { id: "title", component: "Text", variant: "heading", text: "联系表单" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_form",
      components: [
        {
          id: "name",
          component: "TextField",
          label: "姓名",
          placeholder: "你的名字",
          value: { path: "/name" },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_form",
      components: [
        {
          id: "email",
          component: "TextField",
          label: "邮箱",
          placeholder: "you@example.com",
          value: { path: "/email" },
          checks: [
            {
              call: "email",
              args: { value: { path: "/email" } },
              message: "邮箱格式不合法",
            },
          ],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_form",
      components: [
        {
          id: "message",
          component: "TextField",
          label: "留言",
          placeholder: "至少 10 个字",
          value: { path: "/message" },
          checks: [
            {
              call: "length",
              args: { value: { path: "/message" }, min: 10 },
              message: "留言至少 10 个字",
            },
          ],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_form",
      components: [
        {
          id: "submit",
          component: "Button",
          variant: "primary",
          text: "发送",
          checks: [
            {
              call: "email",
              args: { value: { path: "/email" } },
              message: "邮箱未填或非法",
            },
            {
              call: "length",
              args: { value: { path: "/message" }, min: 10 },
              message: "留言太短",
            },
          ],
          action: {
            event: {
              name: "submitContact",
              context: {
                email: { path: "/email" },
                message: { path: "/message" },
              },
            },
          },
        },
      ],
    },
  }),
  // —— 放映尾段：模拟用户输入 —— //
  env({
    updateDataModel: { surfaceId: "g_form", path: "/email", value: "not-an-email" },
  }),
  env({
    updateDataModel: { surfaceId: "g_form", path: "/email", value: "alice@a2ui.org" },
  }),
  env({
    updateDataModel: {
      surfaceId: "g_form",
      path: "/message",
      value: "这是一条来自示例页的留言。",
    },
  }),
];

/* ============================================================ *
 * 3. 书籍列表（ChildList 模板迭代）
 * ============================================================ */
const bookList: A2UIEnvelope[] = [
  env({ createSurface: { surfaceId: "g_books", catalogId: BASIC_CATALOG_ID } }),
  env({
    updateComponents: {
      surfaceId: "g_books",
      components: [{ id: "root", component: "Card", child: "col" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_books",
      components: [
        { id: "col", component: "Column", children: ["title", "list"] },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_books",
      components: [
        { id: "title", component: "Text", variant: "heading", text: "经典科幻推荐" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_books",
      components: [
        {
          id: "list",
          component: "List",
          children: { path: "/books", componentId: "book_row" },
        },
      ],
    },
  }),
  // 模板组件先于数据到达（数据为空时列表渲染为空，不报错）
  env({
    updateComponents: {
      surfaceId: "g_books",
      components: [{ id: "book_row", component: "Card", child: "book_col" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_books",
      components: [
        {
          id: "book_col",
          component: "Column",
          children: ["b_title", "b_author"],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_books",
      components: [
        {
          id: "b_title",
          component: "Text",
          variant: "heading",
          text: { path: "title" },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_books",
      components: [
        {
          id: "b_author",
          component: "Text",
          variant: "caption",
          text: { path: "author" },
        },
      ],
    },
  }),
  // 数据到达 → 列表逐项渲染
  env({
    updateDataModel: {
      surfaceId: "g_books",
      path: "/books",
      value: [
        { title: "三体", author: "刘慈欣" },
        { title: "沙丘", author: "弗兰克·赫伯特" },
        { title: "基地", author: "阿西莫夫" },
      ],
    },
  }),
];

/* ============================================================ *
 * 4. 设置面板 —— CheckBox / Slider / ChoicePicker 写回 dataModel
 * ============================================================ */
const settingsPanel: A2UIEnvelope[] = [
  env({
    createSurface: {
      surfaceId: "g_settings",
      catalogId: BASIC_CATALOG_ID,
      sendDataModel: true,
    },
  }),
  env({
    updateDataModel: {
      surfaceId: "g_settings",
      path: "/",
      value: { darkMode: true, fontSize: 16, accent: "blue" },
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_settings",
      components: [{ id: "root", component: "Card", child: "col" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_settings",
      components: [
        {
          id: "col",
          component: "Column",
          children: ["title", "dark", "font", "accent", "divider", "summary"],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_settings",
      components: [
        { id: "title", component: "Text", variant: "heading", text: "设置" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_settings",
      components: [
        {
          id: "dark",
          component: "CheckBox",
          label: "暗色模式",
          value: { path: "/darkMode" },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_settings",
      components: [
        {
          id: "font",
          component: "Slider",
          label: "字号",
          value: { path: "/fontSize" },
          min: 12,
          max: 24,
          step: 1,
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_settings",
      components: [
        {
          id: "accent",
          component: "ChoicePicker",
          label: "主题色",
          value: { path: "/accent" },
          options: ["red", "green", "blue"],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_settings",
      components: [{ id: "divider", component: "Divider" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_settings",
      components: [
        {
          id: "summary",
          component: "Text",
          variant: "caption",
          text: {
            call: "formatString",
            args: { value: "字号 ${/fontSize}px · 主题色 ${/accent}" },
          },
        },
      ],
    },
  }),
  // —— 模拟交互 —— //
  env({
    updateDataModel: { surfaceId: "g_settings", path: "/fontSize", value: 20 },
  }),
  env({
    updateDataModel: { surfaceId: "g_settings", path: "/accent", value: "green" },
  }),
];

/* ============================================================ *
 * 5. Tabs 多页 —— tabLabels + 多子页
 * ============================================================ */
const tabsDemo: A2UIEnvelope[] = [
  env({ createSurface: { surfaceId: "g_tabs", catalogId: BASIC_CATALOG_ID } }),
  env({
    updateDataModel: { surfaceId: "g_tabs", path: "/", value: { feedback: "" } },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [{ id: "root", component: "Card", child: "tabs" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        {
          id: "tabs",
          component: "Tabs",
          tabLabels: ["欢迎", "FAQ", "反馈"],
          children: ["page1", "page2", "page3"],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        { id: "page1", component: "Column", children: ["p1_title", "p1_text"] },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        { id: "p1_title", component: "Text", variant: "heading", text: "欢迎" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        {
          id: "p1_text",
          component: "Text",
          text: "这是 Tabs 组件的第一个页面，放映时其它页面随后到达。",
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        { id: "page2", component: "List", children: ["q1", "q2", "q3"] },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [{ id: "q1", component: "Text", text: "Q: A2UI 是什么？" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        { id: "q2", component: "Text", text: "Q: 为什么要流式 JSON？" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        { id: "q3", component: "Text", text: "Q: 支持自定义组件吗？" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        { id: "page3", component: "Column", children: ["p3_label", "p3_input", "p3_btn"] },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        {
          id: "p3_label",
          component: "Text",
          variant: "caption",
          text: "留下你的反馈",
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        {
          id: "p3_input",
          component: "TextField",
          placeholder: "说点什么…",
          value: { path: "/feedback" },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_tabs",
      components: [
        {
          id: "p3_btn",
          component: "Button",
          variant: "primary",
          text: "提交反馈",
          action: { event: { name: "submitFeedback" } },
        },
      ],
    },
  }),
];

/* ============================================================ *
 * 6. Modal 弹窗 —— open:{path} 绑定，放映中改 dataModel 控制开合
 * ============================================================ */
const modalDemo: A2UIEnvelope[] = [
  env({ createSurface: { surfaceId: "g_modal", catalogId: BASIC_CATALOG_ID } }),
  env({
    updateDataModel: { surfaceId: "g_modal", path: "/", value: { modalOpen: false } },
  }),
  env({
    updateComponents: {
      surfaceId: "g_modal",
      components: [{ id: "root", component: "Card", child: "col" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_modal",
      components: [
        { id: "col", component: "Column", children: ["title", "open_btn", "modal"] },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_modal",
      components: [
        { id: "title", component: "Text", variant: "heading", text: "Modal 演示" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_modal",
      components: [
        {
          id: "open_btn",
          component: "Button",
          variant: "primary",
          text: "打开详情",
          action: { event: { name: "openModal" } },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_modal",
      components: [
        {
          id: "modal",
          component: "Modal",
          open: { path: "/modalOpen" },
          child: "modal_col",
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_modal",
      components: [
        { id: "modal_col", component: "Column", children: ["m_title", "m_text"] },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_modal",
      components: [
        { id: "m_title", component: "Text", variant: "heading", text: "详情" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_modal",
      components: [
        {
          id: "m_text",
          component: "Text",
          text: "这是一个通过 dataModel /modalOpen 控制开合的 Modal。",
        },
      ],
    },
  }),
  // —— 模拟点击按钮：打开 —— //
  env({
    updateDataModel: { surfaceId: "g_modal", path: "/modalOpen", value: true },
  }),
  // —— 再关上 —— //
  env({
    updateDataModel: { surfaceId: "g_modal", path: "/modalOpen", value: false },
  }),
];

/* ============================================================ *
 * 7. formatString 格式化 —— ${/path} 插值 + 嵌套 formatNumber
 * ============================================================ */
const formatDemo: A2UIEnvelope[] = [
  env({ createSurface: { surfaceId: "g_fmt", catalogId: BASIC_CATALOG_ID } }),
  env({
    updateDataModel: {
      surfaceId: "g_fmt",
      path: "/",
      value: { user: { firstName: "Alice" }, loginCount: 42 },
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_fmt",
      components: [{ id: "root", component: "Card", child: "col" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_fmt",
      components: [
        { id: "col", component: "Column", children: ["hi", "stats", "divider", "count"] },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_fmt",
      components: [
        {
          id: "hi",
          component: "Text",
          variant: "heading",
          text: {
            call: "formatString",
            args: { value: "Hi ${/user/firstName} 👋" },
          },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_fmt",
      components: [
        {
          id: "stats",
          component: "Text",
          text: {
            call: "formatString",
            args: { value: "这是你第 ${/loginCount} 次登录。" },
          },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_fmt",
      components: [{ id: "divider", component: "Divider" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_fmt",
      components: [
        {
          id: "count",
          component: "Text",
          variant: "caption",
          text: {
            call: "formatString",
            args: {
              value: "累计访问 ${formatNumber(value:${/loginCount})} 次（已格式化）",
            },
          },
        },
      ],
    },
  }),
  // —— 模拟登录次数变化 —— //
  env({
    updateDataModel: { surfaceId: "g_fmt", path: "/loginCount", value: 43 },
  }),
];

/* ============================================================ *
 * 8. openUrl 友情链接 —— 本地函数 action，新窗口打开
 * ============================================================ */
const linksDemo: A2UIEnvelope[] = [
  env({ createSurface: { surfaceId: "g_links", catalogId: BASIC_CATALOG_ID } }),
  env({
    updateComponents: {
      surfaceId: "g_links",
      components: [{ id: "root", component: "Card", child: "col" }],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_links",
      components: [
        {
          id: "col",
          component: "Column",
          children: ["title", "intro", "row"],
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_links",
      components: [
        { id: "title", component: "Text", variant: "heading", text: "友情链接" },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_links",
      components: [
        {
          id: "intro",
          component: "Text",
          variant: "caption",
          text: "点击按钮在新窗口打开（本地函数 openUrl，不经过服务端）。",
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_links",
      components: [
        { id: "row", component: "Row", children: ["btn1", "btn2", "btn3"] },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_links",
      components: [
        {
          id: "btn1",
          component: "Button",
          text: "A2UI 官网",
          action: {
            functionCall: { call: "openUrl", args: { url: "https://a2ui.org" } },
          },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_links",
      components: [
        {
          id: "btn2",
          component: "Button",
          text: "React",
          action: {
            functionCall: { call: "openUrl", args: { url: "https://react.dev" } },
          },
        },
      ],
    },
  }),
  env({
    updateComponents: {
      surfaceId: "g_links",
      components: [
        {
          id: "btn3",
          component: "Button",
          variant: "primary",
          text: "Fastify",
          action: {
            functionCall: { call: "openUrl", args: { url: "https://fastify.dev" } },
          },
        },
      ],
    },
  }),
];

export const DEMOS: GalleryDemo[] = [
  {
    id: "card",
    name: "基础卡片",
    description: "Card → Column → Text 渐进出现",
    category: "布局展示",
    surfaceId: "g_card",
    envelopes: basicCard,
  },
  {
    id: "form",
    name: "联系表单（校验）",
    description: "输入双向绑定，按钮随邮箱合法性禁用",
    category: "表单交互",
    surfaceId: "g_form",
    envelopes: contactForm,
  },
  {
    id: "books",
    name: "书籍列表（ChildList）",
    description: "模板迭代 /books 数组逐项渲染",
    category: "模板迭代",
    surfaceId: "g_books",
    envelopes: bookList,
  },
  {
    id: "settings",
    name: "设置面板",
    description: "CheckBox / Slider / ChoicePicker 写回",
    category: "表单交互",
    surfaceId: "g_settings",
    envelopes: settingsPanel,
  },
  {
    id: "tabs",
    name: "Tabs 多页",
    description: "tabLabels + 三个子页面渐进到达",
    category: "布局展示",
    surfaceId: "g_tabs",
    envelopes: tabsDemo,
  },
  {
    id: "modal",
    name: "Modal 弹窗",
    description: "open:{path} 绑定，放映中开/关",
    category: "动态放映",
    surfaceId: "g_modal",
    envelopes: modalDemo,
  },
  {
    id: "format",
    name: "formatString 格式化",
    description: "${/path} 插值 + 嵌套 formatNumber",
    category: "动态放映",
    surfaceId: "g_fmt",
    envelopes: formatDemo,
  },
  {
    id: "links",
    name: "openUrl 友情链接",
    description: "本地函数 action，新窗口打开",
    category: "表单交互",
    surfaceId: "g_links",
    envelopes: linksDemo,
  },
];
