/**
 * Compatibility re-exports — mediation lives in host/bridge/control/.
 * Prefer importing from ../control/index.js in new code.
 */
export {
  onFsRead,
  onFsWrite,
  onFsList,
  onNetRequest,
  onNetResponse,
} from "../control/pipeline.js";

export {
  shouldProcessFsText,
  shouldProcessNetText,
  isTextPath,
  isTextContentType,
  looksLikeTextBuffer,
  isCompressedContent,
  shouldStreamOpaqueBody,
} from "./text.js";
