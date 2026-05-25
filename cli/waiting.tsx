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
const RULE = "\u2500".repeat(72);

export function Waiting({ targetLabel, viewerMessage, url, count, autoSubmit }: Props): React.JSX.Element {
	return (
		<Box flexDirection="column" paddingX={1}>
			<Box>
				<Text bold color={ACCENT}>pi-diff</Text>
				<Text dimColor>  ·  waiting for review</Text>
			</Box>
			<Box><Text dimColor>{RULE}</Text></Box>

			<Box marginTop={1}><Field label="TARGET" value={targetLabel} /></Box>
			<Field label="VIEWER" value={viewerMessage} />
			<Field label="URL" value={url} />

			<Box marginTop={1}>
				<Box width={9}><Text color={count > 0 ? "green" : "gray"}>●</Text></Box>
				<Text bold>{count}</Text>
				<Text dimColor> comment{count === 1 ? "" : "s"} received</Text>
			</Box>

			<Box marginTop={1}><Text dimColor>{RULE}</Text></Box>
			<Box marginTop={1}>
				{autoSubmit ? (
					<Text dimColor>auto-submit · first browser submission ends Phase A · ctrl-c cancels</Text>
				) : count === 0 ? (
					<Text dimColor>write comments in the browser, then click Done · ctrl-c cancels</Text>
				) : (
					<Text dimColor>
						press <Text bold color={ACCENT}>↵</Text> when done · keep submitting more · ctrl-c cancels
					</Text>
				)}
			</Box>
		</Box>
	);
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
	return (
		<Box>
			<Box width={9}><Text dimColor>{label}</Text></Box>
			<Box flexGrow={1}><Text>{value}</Text></Box>
		</Box>
	);
}
