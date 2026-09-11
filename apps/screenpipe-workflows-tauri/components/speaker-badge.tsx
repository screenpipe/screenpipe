"use client";

import { cn } from "@/lib/utils";
import { User } from "lucide-react";

export interface SpeakerBadgeProps {
	speakerId?: number;
	speakerName?: string;
	onClick?: () => void;
	className?: string;
}

export function SpeakerBadge({
	speakerId,
	speakerName,
	onClick,
	className,
}: SpeakerBadgeProps) {
	const isUnknown = !speakerName;
	const displayName = speakerName || `Unknown #${speakerId || "?"}`;

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				// Brand style: sharp corners, black/white only, 1px border
				"inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium transition-all duration-150",
				"border border-border bg-background text-foreground",
				"hover:bg-foreground hover:text-background",
				isUnknown && "border-dashed",
				onClick && "cursor-pointer",
				className
			)}
		>
			<User className="h-3 w-3" />
			<span className="max-w-[100px] truncate">{displayName}</span>
		</button>
	);
}
