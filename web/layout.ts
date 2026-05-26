import type { DiffLayoutMode } from "../core/types";

export function getAppLayoutClassName(
	sidebarCollapsed: boolean,
	sidebarPopoverOpen: boolean,
	layoutMode: DiffLayoutMode = "stream",
): string {
	const classNames = ["app-layout"];
	if (sidebarCollapsed) {
		classNames.push("app-layout--sidebar-collapsed");
	}
	if (sidebarPopoverOpen) {
		classNames.push("app-layout--sidebar-popover-open");
	}
	if (layoutMode === "deck") {
		classNames.push("app-layout--deck");
	}
	return classNames.join(" ");
}
