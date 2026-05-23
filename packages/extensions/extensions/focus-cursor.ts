import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

// Remove the software cursor (reverse-video span) only when the editor also emits
// the hardware cursor marker. This keeps fallback behavior (software cursor)
// in modes where no marker is emitted (e.g. some autocomplete states).
const MARKED_SOFTWARE_CURSOR_RE = /(\x1b_pi:c\x07)\x1b\[7m([^\x1b]*?)\x1b\[(?:0|27)m/g;

class FocusCursorEditor extends CustomEditor {
	override render(width: number): string[] {
		return super.render(width).map((line) => line.replace(MARKED_SOFTWARE_CURSOR_RE, "$1$2"));
	}
}

export default function focusCursorExtension(pi: ExtensionAPI): void {
	let sessionTui: TUI | undefined;
	let previousHardwareCursorMode: boolean | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
			sessionTui = tui;
			previousHardwareCursorMode = tui.getShowHardwareCursor();
			tui.setShowHardwareCursor(true);
			return new FocusCursorEditor(tui, theme, keybindings);
		});
	});

	pi.on("session_shutdown", async () => {
		if (sessionTui && previousHardwareCursorMode !== undefined) {
			sessionTui.setShowHardwareCursor(previousHardwareCursorMode);
		}
		sessionTui = undefined;
		previousHardwareCursorMode = undefined;
	});
}
