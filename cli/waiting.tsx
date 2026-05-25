import React from "react";
import { Box, Text } from "ink";

type Props = {
	targetLabel: string;
	viewerMessage: string;
	url: string;
	count: number;
	autoSubmit: boolean;
};

const ACCENT = "cyan";

export function Waiting({ targetLabel: _t, viewerMessage: _v, url, count, autoSubmit }: Props): React.JSX.Element {
	return (
		<Box flexDirection="column">
			<Box borderStyle="round" borderColor={ACCENT} flexDirection="column" paddingX={2} paddingY={1}>
				<Box marginBottom={1}>
					<Text bold color={ACCENT}>pi-diff</Text>
					<Text dimColor>  ·  waiting for review</Text>
				</Box>

				<Box marginBottom={1}>
					<Text color={count > 0 ? "green" : "gray"}>●</Text>
					<Text>  </Text>
					<Text bold>{count}</Text>
					<Text dimColor> comment{count === 1 ? "" : "s"} received</Text>
				</Box>

				<Box>
					<Box width={6}><Text color="yellow">url</Text></Box>
					<Text>{url}</Text>
				</Box>
			</Box>

			<Box paddingX={2}>
				<Hotkey k={autoSubmit ? "first ↵" : "↵"} label={autoSubmit ? "auto-submit on first send" : "done"} />
				<Text>   </Text>
				<Hotkey k="⌃c" label="cancel" color="red" />
			</Box>
		</Box>
	);
}

function Hotkey({ k, label, color = "cyan" }: { k: string; label: string; color?: string }): React.JSX.Element {
	return (
		<Text>
			<Text bold color={color}>{k}</Text>
			<Text dimColor> {label}</Text>
		</Text>
	);
}
