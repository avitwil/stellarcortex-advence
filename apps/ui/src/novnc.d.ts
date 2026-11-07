// Minimal types for the part of noVNC (MPL-2.0) the live view uses (FR-UI-05).
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | object, options?: { credentials?: { password?: string }; shared?: boolean });
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    sendCtrlAltDel(): void;
  }
}
