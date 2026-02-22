import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useEffect, useRef } from "react";
import React from "react";

export const highlightKeywords = (
	text: string,
	search: string | null
): React.ReactNode => {
	if (!search || !search.trim() || !text) {
		return text;
	}

	const keywords = search.trim().split(/\s+/).filter(Boolean);
	if (keywords.length === 0) {
		return text;
	}

	const escapedKeywords = keywords.map((k) =>
		k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	);
	const regex = new RegExp(`(${escapedKeywords.join("|")})`, "gi");
	const parts = text.split(regex);

	return parts.map((part, index) => {
		const isMatch = keywords.some(
			(keyword) => part.toLowerCase() === keyword.toLowerCase()
		);
		if (isMatch) {
			return (
				<mark
					key={index}
					className="bg-yellow-300 dark:bg-yellow-600 text-inherit px-0.5 rounded"
				>
					{part}
				</mark>
			);
		}
		return part;
	});
};

export const SearchBar = ({
	search,
	onSearchChange,
	disabled,
	autoFocus = false,
}: {
	search: string | null;
	onSearchChange: (value: string) => void;
	disabled?: boolean;
	autoFocus?: boolean;
}) => {
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (autoFocus && inputRef.current) {
			// Small delay to ensure the component is mounted and visible
			const timer = setTimeout(() => {
				inputRef.current?.focus();
			}, 100);
			return () => clearTimeout(timer);
		}
	}, [autoFocus]);

	return (
		<div className="relative w-full">
			<Input
				ref={inputRef}
				type="input"
				placeholder="Search..."
				className="pl-10 h-full bg-card border border-border rounded-lg shadow-sm transition-all duration-200 focus:shadow-md"
				value={search || ""}
				onChange={(e) => {
					onSearchChange(e.target.value);
				}}
				disabled={disabled}
				autoFocus={autoFocus}
			/>
			<Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-neutral-400 w-5 h-5" />
		</div>
	);
};
