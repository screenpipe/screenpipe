import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useEffect, useRef } from "react";

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
