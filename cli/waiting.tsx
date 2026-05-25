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
		<Box flexDirection="column">
			<Text bold>pi-diff</Text>
			<Text>
				<Text dimColor>target: </Text>
				{targetLabel}
			</Text>
			<Text>
				<Text dimColor>viewer: </Text>
				{viewerMessage}
			</Text>
			<Text>
				<Text dimColor>url: </Text>
				{url}
			</Text>
			<Box height={1} />
			<Text>
				<Text dimColor>received: </Text>
				<Text bold color={count > 0 ? "green" : undefined}>{count}</Text>
				<Text dimColor> comment(s)</Text>
			</Text>
			<Box height={1} />
			{autoSubmit ? (
				<Text dimColor>Auto-submit on. The first browser submission ends Phase A. (Ctrl+C cancels)</Text>
			) : count === 0 ? (
				<Text dimColor>Submit comments from the browser. They will accumulate here. Press Enter when done. (q / Ctrl+C cancels)</Text>
			) : (
				<Text>
					<Text>Press </Text>
					<Text bold color="cyan">Enter</Text>
					<Text> when done — or keep submitting more from the browser. (q / Ctrl+C cancels)</Text>
				</Text>
			)}
		</Box>
	);
}
