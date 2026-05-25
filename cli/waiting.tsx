import React from "react";
import { Box, Text } from "ink";

type Props = {
	targetLabel: string;
	viewerMessage: string;
	url: string;
	count: number;
	autoSubmit: boolean;
};

const ACCENT = "magentaBright";
const MUTED = "gray";

function Header(): React.JSX.Element {
	return (
		<Box marginBottom={1}>
			<Text>
				<Text bold color={ACCENT}>◆ pi-diff</Text>
				<Text color={MUTED}>  ·  diff review for the terminal</Text>
			</Text>
		</Box>
	);
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
	return (
		<Box>
			<Box width={10}>
				<Text color={MUTED}>{label}</Text>
			</Box>
			<Text>{value}</Text>
		</Box>
	);
}

export function Waiting({ targetLabel, viewerMessage, url, count, autoSubmit }: Props): React.JSX.Element {
	return (
		<Box flexDirection="column" paddingX={1}>
			<Header />

			<Field label="target" value={targetLabel} />
			<Field label="viewer" value={viewerMessage} />
			<Field label="url" value={url} />

			<Box marginTop={1}>
				<Text>
					<Text color={MUTED}>received  </Text>
					<Text bold color={count > 0 ? "greenBright" : MUTED}>
						{String(count).padStart(2, "0")}
					</Text>
					<Text color={MUTED}>  comments</Text>
				</Text>
			</Box>

			<Box marginTop={1}>
				{autoSubmit ? (
					<Text color={MUTED}>auto-submit on · first submission ends Phase A · ctrl-c cancels</Text>
				) : count === 0 ? (
					<Text color={MUTED}>
						write comments in the browser, then click <Text color={ACCENT}>Done</Text> · ctrl-c cancels
					</Text>
				) : (
					<Text>
						<Text color={MUTED}>press </Text>
						<Text bold color={ACCENT}>Enter</Text>
						<Text color={MUTED}> when done · keep submitting more · ctrl-c cancels</Text>
					</Text>
				)}
			</Box>
		</Box>
	);
}
