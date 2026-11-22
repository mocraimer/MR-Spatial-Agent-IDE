/** Terminal escape sequences: colour (CSI ... m, captured), other CSI, OSC titles, charset picks. */
// eslint-disable-next-line no-control-regex -- matching terminal control characters is the point
export const ANSI = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b./;
// eslint-disable-next-line no-control-regex -- stray control characters would draw as boxes
export const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Terminal text without its escape sequences. */
export function plain(text: string): string { return text.replace(new RegExp(ANSI.source, 'g'), ''); }
