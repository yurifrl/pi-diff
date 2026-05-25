import React from "react";
import { Box, Text } from "ink";

type Props = {
	targetLabel: string;
	viewerMessage: string;
	url: string;
	count: number;
	autoSubmit: boolean;
};

export function Waiting({ targetLabel, viewerMessage, url, count, autoSubmit }: Props): React.JSX.Element {
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box marginBottom={1}>
				<Text bold>pi-diff</Text>
			</Box>

			<Field label="target" value={targetLabel} />
			<Field label="viewer" value={viewerMessage} />
			<Field label="url" value={url} />

			<Box marginTop={1}>
				<Text>
					<Text dimColor>received  </Text>
					<Text bold>{count}</Text>
					<Text dimColor> comment{count === 1 ? "" : "s"}</Text>
				</Text>
			</Box>

			<Box marginTop={1}>
				{autoSubmit ? (
					<Text dimColor>auto-submit · first browser submission ends Phase A · ctrl-c cancels</Text>
				) : count === 0 ? (
					<Text dimColor>write comments in the browser, then click Done · ctrl-c cancels</Text>
				) : (
					<Text dimColor>
						press <Text bold color="white">Enter</Text> when done · keep submitting more · ctrl-c cancels
					</Text>
				)}
			</Box>
		</Box>
	);
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
	return (
		<Box>
			<Box width={9}>
				<Text dimColor>{label}</Text>
			</Box>
			<Box flexGrow={1}>
				<Text>{value}</Text>
			</Box>
		</Box>
	);
}
