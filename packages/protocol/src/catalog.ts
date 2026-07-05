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
];

export const BASIC_FUNCTIONS = [
  "required", "regex", "length", "numeric", "email",
  "and", "or", "not",
  "formatString", "formatNumber", "formatCurrency", "formatDate", "pluralize",
  "openUrl",
];
