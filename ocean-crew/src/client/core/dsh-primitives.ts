// The DSH interface primitives the Bot views draw with. The desktop window seeds DSH's
// primitives module for the plugin, so this import stays external in the client bundle;
// it is here as one named entry point rather than every view importing the platform
// module directly.
export { FishLogo, MarkdownText, writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
