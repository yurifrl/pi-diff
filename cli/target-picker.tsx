import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export type SimpleOption = {
	label: string;
	value: string;
};

type Props = {
	title: string;
	options: SimpleOption[];
	footer?: string;
	onSelect: (value: string) => void;
	onCancel: () => void;
};

export function SimpleSelect({ title, options, footer, onSelect, onCancel }: Props): React.JSX.Element {
	const [index, setIndex] = useState(0);
	const safeIndex = options.length === 0 ? 0 : Math.min(index, options.length - 1);

	useInput((input, key) => {
		if (key.escape || input === "q") {
			onCancel();
			return;
		}
		if (key.upArrow || input === "k") {
			setIndex((i) => (i <= 0 ? Math.max(0, options.length - 1) : i - 1));
			return;
		}
		if (key.downArrow || input === "j") {
			setIndex((i) => (i >= options.length - 1 ? 0 : i + 1));
			return;
		}
		if (key.return) {
			const selected = options[safeIndex];
			if (selected) onSelect(selected.value);
		}
	});

	return (
		<Box flexDirection="column">
			<Text bold>{title}</Text>
			<Box height={1} />
			{options.length === 0 ? (
				<Text dimColor>(no options)</Text>
			) : (
				options.map((opt, i) => {
					const active = i === safeIndex;
					return (
						<Text key={opt.value + i} color={active ? "cyan" : undefined}>
							{active ? "> " : "  "}
							{opt.label}
						</Text>
					);
				})
			)}
			<Box height={1} />
			<Text dimColor>{footer ?? "↑↓ navigate · enter select · q quit"}</Text>
		</Box>
	);
}
