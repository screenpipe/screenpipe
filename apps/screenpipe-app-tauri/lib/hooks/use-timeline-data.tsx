import { StreamTimeSeriesResponse } from "@/components/rewind/timeline";
import { useTimelineStore } from "./use-timeline-store";
import { useEffect, useRef } from "react";

export function useTimelineData(
	currentDate: Date,
	setCurFrame: (frame: StreamTimeSeriesResponse) => void,
) {
	const {
		frames,
		isLoading,
		error,
		message,
		connectWebSocket,
		fetchNextDayData,
		websocket,
		loadFromCache,
	} = useTimelineStore();

	const hasInitialized = useRef(false);

	useEffect(() => {
		// Only initialize once
		if (hasInitialized.current) return;
		hasInitialized.current = true;

		const initialize = async () => {
			// 1. First, load cached frames for instant display
			await loadFromCache();
			
			// 2. Then establish WebSocket connection for live updates
			// The connectWebSocket function handles closing existing connections
			connectWebSocket();
		};

		initialize();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []); // Only connect once when component mounts

	// NOTE: Auto-select of first frame is handled in timeline.tsx to avoid
	// interfering with calendar navigation. Don't add frame selection here.

	return {
		frames,
		isLoading,
		error,
		message,
		fetchNextDayData,
		websocket, // Expose websocket so timeline.tsx can depend on it
	};
}
