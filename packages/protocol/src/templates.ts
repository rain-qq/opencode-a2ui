/**
 * A2UI 模板库 —— 「模型只选模板 + 填数据」的单一真源。
 *
 * 动机: 让 LLM 手写完整的 A2UI 邻接表(组件 id 互相引用、DynamicValue 三态、
 * checks/action 的嵌套形状)出错率很高。改成模型只输出
 *
 *     { "template": "card", "data": { "title": "...", ... } }
 *
 * 由本模块展开成标准 envelope。协议层、渲染层、store 全都不变 —— 展开产物就是
 * 合法的 createSurface / updateComponents / updateDataModel。
 *
 * 每个模板是一个 **builder 函数** 而不是静态组件数组: form 的字段数量/类型/校验
 * 规则由数据决定,静态邻接表表达不了(同一个 TextField 节点无法既做 email 校验
 * 又做长度校验)。list 在 items 为空时也要换一种渲染。
 *
 * 约定:
 *   - builder 绝不 throw。字段缺失/类型不对一律兜底,宁可渲染出一张空卡也不炸流。
 *   - 每个模板恰好一个 id 为 "root" 的组件。
 *   - Button 的文案走 `child` 指向的 Text 组件(协议规范形态)。
 */

import { A2UI_VERSION, BASIC_CATALOG_ID } from "./types.js";
import type {
  A2UIEnvelope,
  ActionSpec,
  CheckSpec,
  ComponentNode,
} from "./types.js";
import { joinPointer } from "./pointer.js";

/* ============================================================ *
 *  容错工具 —— 模型仍会犯的错都收敛在这里
 * ============================================================ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 接受 `{item:[...]}` / `{items:[...]}` 这类 proto 风格包装。部分模型的 tool
 * schema 会把重复字段序列化成单键对象而不是裸数组。
 */
function asArray<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (isPlainObject(v)) {
    for (const key of ["item", "items", "values", "list"]) {
      if (Array.isArray(v[key])) return v[key] as T[];
    }
  }
  return [];
}

function str(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function obj(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** 把任意字符串压成安全的组件 id 片段。 */
function safeId(raw: string, fallback: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || fallback;
}

/**
 * 把 `{label, event?, url?, context?}` 描述的动作转成 ActionSpec。
 * event 优先于 url;两者都缺返回 undefined(调用方渲染成禁用按钮)。
 */
function toAction(spec: Record<string, unknown>): ActionSpec | undefined {
  const event = str(spec.event);
  if (event) {
    const ctx = obj(spec.context);
    const context: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx)) context[k] = v;
    return {
      event: {
        name: event,
        ...(Object.keys(context).length ? { context: context as never } : {}),
      },
    };
  }
  const url = str(spec.url);
  if (url) {
    return { functionCall: { call: "openUrl", args: { url } } };
  }
  return undefined;
}

/** Button + 它的 Text 标签,一次产出两个节点。 */
function buttonPair(
  id: string,
  label: string,
  action: ActionSpec | undefined,
  variant?: string,
  checks?: CheckSpec[]
): ComponentNode[] {
  const labelId = `${id}_label`;
  const btn: ComponentNode = {
    id,
    component: "Button",
    child: labelId,
    ...(variant ? { variant } : {}),
    ...(action ? { action } : { enabled: false }),
    ...(checks?.length ? { checks } : {}),
  };
  return [btn, { id: labelId, component: "Text", text: label || "确定" }];
}

/* ============================================================ *
 *  TemplateSpec
 * ============================================================ */

export interface TemplateBuildResult {
  components: ComponentNode[];
  /** 灌到 path "/" 的初始数据模型。 */
  dataModel: unknown;
  /** 交互产生 action 时是否回传整个 dataModel(表单需要)。 */
  sendDataModel?: boolean;
}

/**
 * 一个字段的声明式描述。opencode 插件按这个生成 zod schema —— 所以字段的**类型
 * 约束住在这里**,是模型能看到的唯一契约。
 *
 * 有意保持简陋: 只有 A2UI 模板真正需要的那几种形状。加一种 kind 就要同步改插件
 * 侧的 zod 映射,不值得为了通用性提前抽象。
 */
export type ArgSpec =
  | { kind: "string"; describe: string; optional?: boolean }
  | { kind: "number"; describe: string; optional?: boolean }
  | { kind: "boolean"; describe: string; optional?: boolean }
  | { kind: "enum"; values: string[]; describe: string; optional?: boolean }
  | { kind: "stringArray"; describe: string; optional?: boolean }
  /**
   * 形状自由的数组。用于表格的 rows —— 每行既可以是 string[] 也可以是以列名为键
   * 的对象(模型两种都会写),再往下约束反而会把合法输入挡掉。归一化交给
   * normalizeTable。
   */
  | { kind: "unknownArray"; describe: string; optional?: boolean }
  | { kind: "record"; describe: string; optional?: boolean }
  | {
      kind: "objectArray";
      describe: string;
      optional?: boolean;
      /** 数组项的字段。 */
      fields: Record<string, ArgSpec>;
    };

export interface TemplateSpec {
  name: string;
  /** 暴露给模型的工具名(插件 hooks.tool 的键)。 */
  toolName: string;
  /** 工具的一句话用途。进工具 description 与 prompt。 */
  description: string;
  /**
   * 工具参数声明。插件据此生成 zod schema,模型看到的就是这些字段。
   * 顶层字段直接是工具入参 —— 模型不需要再包一层 data。
   */
  args: Record<string, ArgSpec>;
  /** 展开成组件 + 初始数据。必须容错,绝不 throw。 */
  build(data: Record<string, unknown>): TemplateBuildResult;
}

/* ============================================================ *
 *  card —— 信息卡片(可带图片与操作按钮)
 * ============================================================ */

const cardTemplate: TemplateSpec = {
  name: "card",
  toolName: "render_card",
  description:
    "在用户界面渲染一张信息卡片(标题 + 正文,可选配图、脚注、一排操作按钮)。" +
    "适合展示结论、状态、单条结果。正文支持 markdown。",
  args: {
    title: { kind: "string", describe: "卡片标题,必填" },
    description: {
      kind: "string",
      describe: "正文,支持 markdown",
      optional: true,
    },
    imageUrl: { kind: "string", describe: "配图 URL", optional: true },
    footnote: {
      kind: "string",
      describe: "脚注,小字显示在底部",
      optional: true,
    },
    actions: {
      kind: "objectArray",
      describe:
        "底部操作按钮。event 是点击后回传给你的事件名;url 则在新窗口打开链接。二者给其一。",
      optional: true,
      fields: {
        label: { kind: "string", describe: "按钮文案" },
        event: {
          kind: "string",
          describe: "点击后回传的事件名",
          optional: true,
        },
        url: { kind: "string", describe: "点击后打开的链接", optional: true },
        context: {
          kind: "record",
          describe: "随事件回传的附加数据",
          optional: true,
        },
      },
    },
  },

  build(data) {
    const title = str(data.title);
    const description = str(data.description);
    const imageUrl = str(data.imageUrl);
    const footnote = str(data.footnote);
    const actions = asArray(data.actions).map(obj).filter((a) => str(a.label));

    const components: ComponentNode[] = [
      { id: "root", component: "Card", child: "col" },
    ];
    const colChildren: string[] = [];

    if (imageUrl) {
      colChildren.push("img");
      components.push({
        id: "img",
        component: "Image",
        url: { path: "/imageUrl" },
        alt: { path: "/title" },
      });
    }

    colChildren.push("title");
    components.push({
      id: "title",
      component: "Text",
      variant: "heading",
      text: { path: "/title" },
    });

    if (description) {
      colChildren.push("desc");
      components.push({
        id: "desc",
        component: "Text",
        text: { path: "/description" },
      });
    }

    if (footnote) {
      colChildren.push("note_divider", "note");
      components.push({ id: "note_divider", component: "Divider" });
      components.push({
        id: "note",
        component: "Text",
        variant: "caption",
        text: { path: "/footnote" },
      });
    }

    if (actions.length) {
      colChildren.push("footer");
      const actionIds: string[] = [];
      actions.forEach((a, i) => {
        const id = `act_${i}`;
        actionIds.push(id);
        components.push(
          ...buttonPair(
            id,
            str(a.label),
            toAction(a),
            i === 0 ? "primary" : undefined
          )
        );
      });
      components.push({
        id: "footer",
        component: "CardFooter",
        children: actionIds,
      });
    }

    components.push({ id: "col", component: "Column", children: colChildren });

    return {
      components,
      dataModel: { title, description, imageUrl, footnote },
    };
  },
};

/* ============================================================ *
 *  list —— 可点列表(ChildList 模板迭代)
 * ============================================================ */

const listTemplate: TemplateSpec = {
  name: "list",
  toolName: "render_list",
  description:
    "在用户界面渲染一个条目列表(每行标题 + 可选副标题/角标)。" +
    "给了 clickEvent 时整行可点击,用户点哪一行会把该行的 id 回传给你。" +
    "适合让用户从若干选项里挑一个。",
  args: {
    items: {
      kind: "objectArray",
      describe: "列表条目,必填",
      fields: {
        id: {
          kind: "string",
          describe: "条目标识,点击时回传给你。不给则自动编号。",
          optional: true,
        },
        title: { kind: "string", describe: "条目主标题" },
        subtitle: { kind: "string", describe: "副标题,小字", optional: true },
        badge: {
          kind: "string",
          describe: "右侧角标,如评分/数量",
          optional: true,
        },
      },
    },
    title: { kind: "string", describe: "列表标题", optional: true },
    clickEvent: {
      kind: "string",
      describe: "整行可点击时,点击回传的事件名。不给则列表只读。",
      optional: true,
    },
    emptyHint: {
      kind: "string",
      describe: "items 为空时显示的提示文案",
      optional: true,
    },
  },

  build(data) {
    const title = str(data.title);
    const clickEvent = str(data.clickEvent);
    const emptyHint = str(data.emptyHint) || "暂无条目";

    // 补齐每项的 id —— ChildList 迭代时渲染层用它做 React key,
    // 点击 action 的 context 也要靠它告诉 agent 点了哪一项。
    const items = asArray(data.items)
      .map(obj)
      .map((it, i) => ({
        id: str(it.id) || `_i${i}`,
        title: str(it.title),
        subtitle: str(it.subtitle),
        badge: str(it.badge),
      }));

    const components: ComponentNode[] = [
      { id: "root", component: "Card", child: "col" },
    ];
    const colChildren: string[] = [];

    if (title) {
      colChildren.push("title");
      components.push({
        id: "title",
        component: "Text",
        variant: "heading",
        text: { path: "/title" },
      });
    }

    if (items.length === 0) {
      // List 组件没有 emptyHint prop,所以空态换成一条 caption 文本,
      // 而不是渲染一个什么都不显示的空 List。
      colChildren.push("empty");
      components.push({
        id: "empty",
        component: "Text",
        variant: "caption",
        text: { path: "/emptyHint" },
      });
    } else {
      colChildren.push("list");
      components.push({
        id: "list",
        component: "List",
        children: { path: "/items", componentId: "row" },
      });

      // 行内路径是相对的 —— 在 ChildList scope 下解析到当前项。
      const rowInner: ComponentNode[] = [
        {
          id: "row_col",
          component: "Column",
          children: ["row_title", "row_meta"],
        },
        {
          id: "row_title",
          component: "Text",
          text: { path: "title" },
        },
        {
          id: "row_meta",
          component: "Row",
          children: ["row_sub", "row_badge"],
        },
        {
          id: "row_sub",
          component: "Text",
          variant: "caption",
          text: { path: "subtitle" },
        },
        {
          id: "row_badge",
          component: "Text",
          variant: "caption",
          text: { path: "badge" },
        },
      ];

      components.push(
        clickEvent
          ? {
              id: "row",
              component: "Button",
              variant: "borderless",
              child: "row_col",
              action: {
                event: {
                  name: clickEvent,
                  context: { id: { path: "id" }, title: { path: "title" } },
                },
              },
            }
          : { id: "row", component: "Card", child: "row_col" },
        ...rowInner
      );
    }

    components.push({ id: "col", component: "Column", children: colChildren });

    return { components, dataModel: { title, emptyHint, items } };
  },
};

/* ============================================================ *
 *  form —— 表单(逐字段生成组件 + 对应 checks)
 * ============================================================ */

/** 一个字段展开出的组件 + 它自己的 checks(会被汇总到提交按钮上)。 */
interface FieldBuild {
  node: ComponentNode;
  checks: CheckSpec[];
  /** 数据模型里的初值。 */
  initial: unknown;
}

function buildField(
  raw: Record<string, unknown>,
  index: number
): FieldBuild | undefined {
  const name = str(raw.name);
  if (!name) return undefined;

  const id = `f${index}_${safeId(name, "x")}`;
  const label = str(raw.label) || name;
  const placeholder = str(raw.placeholder);
  const pointer = joinPointer("", name); // 自动做 RFC6901 转义
  const value = { path: pointer };
  const type = str(raw.type) || "text";
  const required = raw.required === true;

  const checks: CheckSpec[] = [];
  if (required) {
    checks.push({
      call: "required",
      args: { value },
      message: `${label}不能为空`,
    });
  }

  switch (type) {
    case "checkbox":
      return {
        node: { id, component: "CheckBox", label, value },
        checks,
        initial: raw.default === true,
      };

    case "choice": {
      const options = asArray(raw.options).map(str).filter(Boolean);
      return {
        node: { id, component: "ChoicePicker", label, value, options },
        checks,
        initial: str(raw.default),
      };
    }

    case "date":
      return {
        node: { id, component: "DateTimeInput", label, value },
        checks,
        initial: str(raw.default),
      };

    case "slider": {
      const min = num(raw.min) ?? 0;
      const max = num(raw.max) ?? 100;
      return {
        node: {
          id,
          component: "Slider",
          label,
          value,
          min,
          max,
          ...(num(raw.step) !== undefined ? { step: num(raw.step) } : {}),
        },
        checks,
        initial: num(raw.default) ?? min,
      };
    }

    case "email":
      checks.push({
        call: "email",
        args: { value },
        message: `${label}格式不合法`,
      });
      break;

    case "number": {
      // 走 TextField + numeric 校验而不是 Slider —— 没有 min/max 时
      // Slider 的 0-100 默认区间会把值悄悄夹断。
      const min = num(raw.min);
      const max = num(raw.max);
      checks.push({
        call: "numeric",
        args: {
          value,
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
        },
        message: `${label}必须是数字`,
      });
      break;
    }

    default:
      break;
  }

  const minLength = num(raw.minLength);
  if (minLength !== undefined) {
    checks.push({
      call: "length",
      args: { value, min: minLength },
      message: `${label}至少 ${minLength} 个字`,
    });
  }

  return {
    node: {
      id,
      component: "TextField",
      label,
      value,
      ...(placeholder ? { placeholder } : {}),
      ...(checks.length ? { checks } : {}),
    },
    checks,
    initial: str(raw.default),
  };
}

const formTemplate: TemplateSpec = {
  name: "form",
  toolName: "render_form",
  description:
    "在用户界面渲染一个表单。逐字段生成输入控件与校验;校验未通过时提交按钮自动禁用。" +
    "用户提交后,所有字段值会以 submitEvent 回传给你。适合需要用户填信息的场景。",
  args: {
    submitEvent: {
      kind: "string",
      describe: "用户提交时回传的事件名,必填",
    },
    fields: {
      kind: "objectArray",
      describe: "表单字段,必填。每项生成一个输入控件。",
      fields: {
        name: {
          kind: "string",
          describe: "字段名。提交时用它作为回传数据的键。",
        },
        label: {
          kind: "string",
          describe: "字段标签。不给则用 name。",
          optional: true,
        },
        type: {
          kind: "enum",
          values: ["text", "email", "number", "date", "checkbox", "choice", "slider"],
          describe: "控件类型,默认 text。email/number 会自动加上格式校验。",
          optional: true,
        },
        placeholder: {
          kind: "string",
          describe: "输入框占位提示",
          optional: true,
        },
        options: {
          kind: "stringArray",
          describe: 'type 为 "choice" 时的可选项',
          optional: true,
        },
        required: { kind: "boolean", describe: "是否必填", optional: true },
        minLength: {
          kind: "number",
          describe: "最小字符数",
          optional: true,
        },
        min: { kind: "number", describe: "数值/滑块下限", optional: true },
        max: { kind: "number", describe: "数值/滑块上限", optional: true },
      },
    },
    title: { kind: "string", describe: "表单标题", optional: true },
    description: {
      kind: "string",
      describe: "表单说明,支持 markdown",
      optional: true,
    },
    submitLabel: {
      kind: "string",
      describe: "提交按钮文案,默认「提交」",
      optional: true,
    },
  },

  build(data) {
    const title = str(data.title);
    const description = str(data.description);
    const submitEvent = str(data.submitEvent) || "submitForm";
    const submitLabel = str(data.submitLabel) || "提交";

    const built = asArray(data.fields)
      .map(obj)
      .map((f, i) => ({ raw: f, built: buildField(f, i) }))
      .filter((x): x is { raw: Record<string, unknown>; built: FieldBuild } =>
        Boolean(x.built)
      );

    const components: ComponentNode[] = [
      { id: "root", component: "Card", child: "col" },
    ];
    const colChildren: string[] = [];

    if (title) {
      colChildren.push("title");
      components.push({
        id: "title",
        component: "Text",
        variant: "heading",
        text: { path: "/title" },
      });
    }
    if (description) {
      colChildren.push("desc");
      components.push({
        id: "desc",
        component: "Text",
        text: { path: "/description" },
      });
    }

    const dataModel: Record<string, unknown> = { title, description };
    const allChecks: CheckSpec[] = [];
    const submitContext: Record<string, unknown> = {};

    for (const { raw, built: fb } of built) {
      colChildren.push(fb.node.id);
      components.push(fb.node);
      allChecks.push(...fb.checks);
      const name = str(raw.name);
      dataModel[name] = fb.initial;
      submitContext[name] = { path: joinPointer("", name) };
    }

    colChildren.push("submit");
    components.push(
      ...buttonPair(
        "submit",
        submitLabel,
        {
          event: {
            name: submitEvent,
            ...(Object.keys(submitContext).length
              ? { context: submitContext as never }
              : {}),
          },
        },
        "primary",
        allChecks
      )
    );

    components.push({ id: "col", component: "Column", children: colChildren });

    return { components, dataModel, sendDataModel: true };
  },
};

/* ============================================================ *
 *  confirm —— 确认对话
 * ============================================================ */

const confirmTemplate: TemplateSpec = {
  name: "confirm",
  toolName: "render_confirm",
  description:
    "在用户界面渲染一张确认卡片(说明 + 确认/取消按钮)。" +
    "用户点哪个按钮会把对应事件回传给你。用于需要用户放行的操作 —— " +
    "危险操作前务必先渲染它等用户确认,而不是直接执行。",
  args: {
    title: { kind: "string", describe: "确认标题,必填" },
    confirmEvent: {
      kind: "string",
      describe: "用户点确认时回传的事件名,必填",
    },
    message: {
      kind: "string",
      describe: "说明文案,支持 markdown。讲清后果。",
      optional: true,
    },
    confirmLabel: {
      kind: "string",
      describe: "确认按钮文案,默认「确认」",
      optional: true,
    },
    cancelEvent: {
      kind: "string",
      describe: "取消按钮回传的事件名。不给则不显示取消按钮。",
      optional: true,
    },
    cancelLabel: {
      kind: "string",
      describe: "取消按钮文案,默认「取消」",
      optional: true,
    },
    context: {
      kind: "record",
      describe: "随两个事件一起回传的附加数据,用来认领是哪一条确认",
      optional: true,
    },
  },

  build(data) {
    const title = str(data.title) || "请确认";
    const message = str(data.message);
    const context = obj(data.context);
    const confirmEvent = str(data.confirmEvent) || "confirm";
    const cancelEvent = str(data.cancelEvent);

    const components: ComponentNode[] = [
      { id: "root", component: "Card", child: "col" },
      {
        id: "title",
        component: "Text",
        variant: "heading",
        text: { path: "/title" },
      },
    ];
    const colChildren = ["title"];

    if (message) {
      colChildren.push("msg");
      components.push({
        id: "msg",
        component: "Text",
        text: { path: "/message" },
      });
    }

    const footerChildren: string[] = [];
    if (cancelEvent) {
      footerChildren.push("cancel");
      components.push(
        ...buttonPair("cancel", str(data.cancelLabel) || "取消", {
          event: {
            name: cancelEvent,
            ...(Object.keys(context).length
              ? { context: context as never }
              : {}),
          },
        })
      );
    }
    footerChildren.push("ok");
    components.push(
      ...buttonPair(
        "ok",
        str(data.confirmLabel) || "确认",
        {
          event: {
            name: confirmEvent,
            ...(Object.keys(context).length
              ? { context: context as never }
              : {}),
          },
        },
        "primary"
      )
    );

    colChildren.push("footer");
    components.push({
      id: "footer",
      component: "CardFooter",
      children: footerChildren,
    });
    components.push({ id: "col", component: "Column", children: colChildren });

    return { components, dataModel: { title, message } };
  },
};

/* ============================================================ *
 *  table —— 独立表格
 * ============================================================ */

/**
 * 归一化表格数据。columns 是表头,rows 是每行的单元格数组。
 * 容错: rows 里的项可能是对象(按 columns 顺序取值)而不是数组 —— 模型偶尔会这么
 * 写,毕竟对象更自然。两种都接。
 */
function normalizeTable(
  rawColumns: unknown,
  rawRows: unknown
): { columns: string[]; rows: string[][] } {
  const columns = asArray(rawColumns).map(str).filter(Boolean);
  const rows = asArray(rawRows).map((row) => {
    if (Array.isArray(row)) return row.map(str);
    if (isPlainObject(row)) {
      // 对象形态: 按 columns 顺序取值。columns 为空时退回对象自身的值顺序。
      if (columns.length) return columns.map((c) => str(row[c]));
      return Object.values(row).map(str);
    }
    return [str(row)];
  });
  return { columns, rows };
}

const tableTemplate: TemplateSpec = {
  name: "table",
  toolName: "render_table",
  description:
    "在用户界面渲染一张表格。适合多行多列的结构化数据(查询结果、对比、清单)。" +
    "比 markdown 表格更适合数据量大的情况。纯展示,不可交互。",
  args: {
    columns: {
      kind: "stringArray",
      describe: "表头,按列顺序。必填。",
    },
    rows: {
      kind: "unknownArray",
      describe:
        "数据行。每行是一个字符串数组(按 columns 顺序),也可以是以列名为键的对象。必填。",
    },
    title: { kind: "string", describe: "表格标题", optional: true },
    emptyHint: {
      kind: "string",
      describe: "rows 为空时的提示文案",
      optional: true,
    },
  },

  build(data) {
    const title = str(data.title);
    const emptyHint = str(data.emptyHint) || "暂无数据";
    const { columns, rows } = normalizeTable(data.columns, data.rows);

    const components: ComponentNode[] = [
      { id: "root", component: "Card", child: "col" },
    ];
    const colChildren: string[] = [];

    if (title) {
      colChildren.push("title");
      components.push({
        id: "title",
        component: "Text",
        variant: "heading",
        text: { path: "/title" },
      });
    }

    colChildren.push("table");
    components.push({
      id: "table",
      component: "DataTable",
      columns: { path: "/columns" },
      rows: { path: "/rows" },
      emptyHint: { path: "/emptyHint" },
    });
    components.push({ id: "col", component: "Column", children: colChildren });

    return { components, dataModel: { title, columns, rows, emptyHint } };
  },
};

/* ============================================================ *
 *  process —— 执行过程控制台
 *
 *  这是唯一一个「会被反复更新」的模板: 步骤推进时模型带上同一个 surfaceId 再调
 *  一次,整棵树按 id 覆盖、数据整根替换,视觉上就是原地刷新。
 * ============================================================ */

const STEP_STATUSES = ["pending", "active", "completed"];

const processTemplate: TemplateSpec = {
  name: "process",
  toolName: "render_process",
  description:
    "在用户界面渲染一个执行过程控制台: 左侧步骤时间轴 + 顶部进度条 + 可选的产物表格和操作按钮。" +
    "适合多步骤任务 —— 让用户随时看到走到哪一步、每步产出了什么。" +
    "步骤推进时用同一个 surfaceId 再调一次即可原地刷新,不要新开一张。",
  args: {
    steps: {
      kind: "objectArray",
      describe: "步骤列表,必填。按执行顺序排列。",
      fields: {
        title: { kind: "string", describe: "步骤名称" },
        status: {
          kind: "enum",
          values: STEP_STATUSES,
          describe:
            'completed=已完成(打勾), active=正在执行(脉冲点), pending=待执行(序号)。默认 pending。同一时刻只应有一个 active。',
          optional: true,
        },
        id: {
          kind: "string",
          describe: "步骤标识。不给则自动编号。",
          optional: true,
        },
      },
    },
    title: {
      kind: "string",
      describe: "顶部进度条的标题,如「当前步骤: 2/5 测试项生成」",
      optional: true,
    },
    percent: {
      kind: "number",
      describe: "总体进度百分比 0-100。不给则按 completed 步数自动算。",
      optional: true,
    },
    tableColumns: {
      kind: "stringArray",
      describe: "产物表格的表头。与 tableRows 一起给才会渲染表格。",
      optional: true,
    },
    tableRows: {
      kind: "unknownArray",
      describe: "产物表格的数据行,形状同 render_table 的 rows。",
      optional: true,
    },
    actions: {
      kind: "objectArray",
      describe:
        "底部操作按钮,如「确认并下一步」「回退」。event 是点击后回传给你的事件名。",
      optional: true,
      fields: {
        label: { kind: "string", describe: "按钮文案" },
        event: { kind: "string", describe: "点击后回传的事件名" },
        context: {
          kind: "record",
          describe: "随事件回传的附加数据",
          optional: true,
        },
      },
    },
  },

  build(data) {
    // 步骤: 补 id(ChildList 迭代要用它做 key)与 num(时间轴上显示的序号)。
    const steps = asArray(data.steps)
      .map(obj)
      .map((s, i) => {
        const status = str(s.status);
        return {
          id: str(s.id) || `_s${i}`,
          num: String(i + 1),
          title: str(s.title),
          status: STEP_STATUSES.includes(status) ? status : "pending",
        };
      });

    const done = steps.filter((s) => s.status === "completed").length;
    const activeIdx = steps.findIndex((s) => s.status === "active");
    // 光标 = 用户视角的「第几步」。有 active 就是它,否则是已完成的下一步。
    const cursor = activeIdx >= 0 ? activeIdx + 1 : done;

    // 自动进度: 正在执行的那一步算**半步**。纯按 completed 数算的话,「4 步做完 1
    // 步、第 2 步在跑」会显示 25%,配着「2/4」的标签看起来像倒退了;算上半步得
    // 37%,与光标位置一致。模型显式给了 percent 就用它的。
    const autoPercent = steps.length
      ? Math.round(((done + (activeIdx >= 0 ? 0.5 : 0)) / steps.length) * 100)
      : 0;
    const percent = Math.max(
      0,
      Math.min(100, num(data.percent) ?? autoPercent)
    );

    // 进度条标题不给时自动生成 —— 让用户至少知道走到第几步。
    const title =
      str(data.title) ||
      (steps.length ? `当前步骤: ${cursor}/${steps.length}` : "执行进度");

    const { columns, rows } = normalizeTable(data.tableColumns, data.tableRows);
    const hasTable = columns.length > 0 || rows.length > 0;

    const actions = asArray(data.actions)
      .map(obj)
      .filter((a) => str(a.label) && str(a.event));

    const components: ComponentNode[] = [
      { id: "root", component: "Card", child: "col" },
      {
        id: "progress",
        component: "StepProgress",
        title: { path: "/title" },
        percent: { path: "/percent" },
        progressLabel: { path: "/progressLabel" },
      },
      // 时间轴。children 是模板绑定 —— 渲染层为 /steps 每一项渲染一份 step_item,
      // 并把该项的绝对路径作为 scope 传下去,所以 step_item 里用相对路径。
      {
        id: "steplist",
        component: "StepList",
        emptyHint: "暂无步骤",
        children: { path: "/steps", componentId: "step_item" },
      },
      {
        id: "step_item",
        component: "StepItem",
        num: { path: "num" },
        title: { path: "title" },
        status: { path: "status" },
      },
    ];

    const splitChildren = ["steplist"];
    if (hasTable) {
      splitChildren.push("table");
      components.push({
        id: "table",
        component: "DataTable",
        columns: { path: "/columns" },
        rows: { path: "/rows" },
        emptyHint: "本步骤暂无产物",
      });
    }
    components.push({
      id: "split",
      component: "Row",
      children: splitChildren,
    });

    const colChildren = ["progress", "split"];

    if (actions.length) {
      colChildren.push("footer");
      const actionIds: string[] = [];
      actions.forEach((a, i) => {
        const id = `act_${i}`;
        actionIds.push(id);
        components.push(
          ...buttonPair(
            id,
            str(a.label),
            toAction(a),
            // 最后一个按钮通常是「下一步」这类主操作。
            i === actions.length - 1 ? "primary" : undefined
          )
        );
      });
      components.push({
        id: "footer",
        component: "CardFooter",
        children: actionIds,
      });
    }

    components.push({ id: "col", component: "Column", children: colChildren });

    return {
      components,
      dataModel: {
        title,
        percent,
        progressLabel: steps.length ? `${cursor}/${steps.length}` : "",
        steps,
        columns,
        rows,
      },
    };
  },
};

/* ============================================================ *
 *  注册表 + 展开
 * ============================================================ */

export const TEMPLATES: Record<string, TemplateSpec> = {
  card: cardTemplate,
  list: listTemplate,
  form: formTemplate,
  confirm: confirmTemplate,
  table: tableTemplate,
  process: processTemplate,
};

export const TEMPLATE_NAMES: string[] = Object.keys(TEMPLATES);

/**
 * 工具名 → 模板名。适配器靠它认出「这个 tool_call 是一次 UI 渲染」。
 * 从 TEMPLATES 派生,加模板不用改这里。
 */
export const TOOL_TO_TEMPLATE: Record<string, string> = Object.fromEntries(
  Object.values(TEMPLATES).map((t) => [t.toolName, t.name])
);

/** 这个工具名是否是 A2UI 渲染工具。 */
export function isRenderTool(toolName: string): boolean {
  return toolName in TOOL_TO_TEMPLATE;
}

/**
 * 把一次模板调用展开成三条标准 envelope。
 *
 * 同一个 surfaceId 再展开一次即为「更新这张卡」: store 的 createSurface 对已存在
 * 的 id 幂等,updateComponents 按 id 覆盖,updateDataModel 以 path "/" 整根替换。
 *
 * 未知模板名返回空数组 —— 调用方据此降级(不发 a2ui 事件),而不是炸掉整条流。
 */
export function expandTemplate(
  name: string,
  data: unknown,
  surfaceId: string
): A2UIEnvelope[] {
  const spec = TEMPLATES[name];
  if (!spec) return [];

  let built: TemplateBuildResult;
  try {
    built = spec.build(obj(data));
  } catch {
    // builder 契约上不该 throw;真炸了也不能带走整条流。
    return [];
  }
  if (!built.components.length) return [];

  return [
    {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId,
        catalogId: BASIC_CATALOG_ID,
        ...(built.sendDataModel ? { sendDataModel: true } : {}),
      },
    },
    {
      version: A2UI_VERSION,
      updateComponents: { surfaceId, components: built.components },
    },
    {
      version: A2UI_VERSION,
      updateDataModel: { surfaceId, path: "/", value: built.dataModel },
    },
  ];
}
