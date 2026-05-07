import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	if (!process.env.TMUX) return;

	const enterCopyModeAndScroll = async (direction: "halfpage-up" | "halfpage-down") => {
		await pi.exec("tmux", ["copy-mode"]);
		await pi.exec("tmux", ["send-keys", "-X", direction]);
	};

	pi.registerShortcut("ctrl+u", {
		description: "tmux copy-mode + half page up",
		handler: () => enterCopyModeAndScroll("halfpage-up"),
	});

	pi.registerShortcut("ctrl+d", {
		description: "tmux copy-mode + half page down",
		handler: () => enterCopyModeAndScroll("halfpage-down"),
	});
}
