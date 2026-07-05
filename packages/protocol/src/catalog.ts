/**
 * Compact description of the A2UI basic catalog (v0.9.1).
 * Used to build the LLM system prompt and (optionally) client-side validation.
 */

export interface ComponentSpec {
  name: string;
  /** "container-single" -> uses `child`; "container-multi" -> uses `children`; "leaf" otherwise. */
  kind: "container-single" | "container-multi" | "leaf";
  description: string;
  /** Notable props (free-form documentation for the LLM). */
  props?: string;
}

export const BASIC_CATALOG: ComponentSpec[] = [
  // Layout / display
  { name: "Text", kind: "leaf", description: "Simple Markdown text.", props: 'text: DynamicString; variant?: "body"|"caption"|"heading"' },
  { name: "Image", kind: "leaf", description: "Image from URL.", props: "url: DynamicString; alt?: DynamicString" },
  { name: "Icon", kind: "leaf", description: "Icon by name.", props: "name: DynamicString" },
  { name: "Video", kind: "leaf", description: "Video player.", props: "url: DynamicString" },
  { name: "AudioPlayer", kind: "leaf", description: "Audio player.", props: "url: DynamicString" },
  { name: "Row", kind: "container-multi", description: "Horizontal layout.", props: "children: ChildList" },
  { name: "Column", kind: "container-multi", description: "Vertical layout.", props: "children: ChildList" },
  { name: "List", kind: "container-multi", description: "Vertical list of items, ideal for ChildList templates.", props: "children: ChildList" },
  { name: "Card", kind: "container-single", description: "Bordered content container.", props: "child: ComponentId" },
  { name: "Tabs", kind: "container-multi", description: "Tab bar; each child is a tab page.", props: "children: ChildList; tabLabels: DynamicStringList" },
  { name: "Divider", kind: "leaf", description: "Horizontal rule." },
  { name: "Modal", kind: "container-single", description: "Dialog. open: DynamicBoolean.", props: "child: ComponentId; open?: DynamicBoolean" },

  // Interactive
  { name: "Button", kind: "container-single", description: "Clickable button. Use `child` for its label component.", props: 'child: ComponentId; variant?: "primary"|"borderless"; action?: ActionSpec; checks?: Check[]' },
  { name: "CheckBox", kind: "leaf", description: "Boolean input.", props: "label?: DynamicString; value: DynamicBoolean (typically {path})" },
  { name: "TextField", kind: "leaf", description: "Text input.", props: "label?: DynamicString; value: DynamicString; placeholder?: DynamicString; checks?: Check[]" },
  { name: "DateTimeInput", kind: "leaf", description: "Date/time picker.", props: "label?: DynamicString; value: DynamicString" },
  { name: "ChoicePicker", kind: "leaf", description: "Single-choice picker.", props: "label?: DynamicString; value: DynamicString; options: DynamicStringList" },
  { name: "Slider", kind: "leaf", description: "Numeric slider.", props: "label?: DynamicString; value: DynamicNumber; min?: number; max?: number; step?: number" },

  // Process / dashboard helpers — used together to render an execution
  // console: left-side step timeline, top progress strip, body table.
  {
    name: "StepList",
    kind: "container-multi",
    description:
      "Vertical timeline of process steps. Children iterate a template over a steps array; each item shows num/title/status and is clickable. Selection highlight is driven by the template item's `selected` field, independent of `status`.",
    props:
      'children: ChildList (template: { path: "/steps", componentId: "step-item" }); emptyHint?: DynamicString',
  },
  {
    name: "StepItem",
    kind: "leaf",
    description:
      "Template row rendered by StepList for each entry in the steps array. status drives the marker (completed=check, active=pulse dot, pending=number); selected independently highlights the currently focused step.",
    props:
      'num: DynamicString; title: DynamicString; status: DynamicString ("completed"|"active"|"pending"); progress?: DynamicString; selected?: DynamicBoolean; action?: ActionSpec',
  },
  {
    name: "StepProgress",
    kind: "leaf",
    description:
      "Header strip showing the current step title plus a percent and a progress bar.",
    props:
      "title: DynamicString; percent: DynamicNumber (0-100); progressLabel?: DynamicString",
  },
  {
    name: "DataTable",
    kind: "leaf",
    description:
      "Tabular artifact view: column headers + string rows. Useful as the 'middle product' panel of a step.",
    props:
      "columns: DynamicStringList; rows: DynamicStringList (array of arrays); emptyHint?: DynamicString",
  },
  {
    name: "CardFooter",
    kind: "container-multi",
    description:
      "Bottom action bar of a card-like surface. Children are laid out horizontally; items that overflow the available width are collected into a '更多' dropdown menu. Each child keeps its original action semantics.",
    props:
      'children: ChildList (Button / TextField / etc.)',
  },
];

export const BASIC_FUNCTIONS = [
  "required", "regex", "length", "numeric", "email",
  "and", "or", "not",
  "formatString", "formatNumber", "formatCurrency", "formatDate", "pluralize",
  "openUrl",
];
