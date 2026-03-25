import { useState } from "react";
import { Loader2, Video } from "lucide-react";
import { useTimelineSelection } from "@/lib/hooks/use-timeline-selection";
import { toast } from "@/components/ui/use-toast";
import { useSettings } from "@/lib/hooks/use-settings";
import { parseInt } from "lodash";
import posthog from "posthog-js";
import { cn } from "@/lib/utils";

export function ExportButton() {
	const [isExporting, setIsExporting] = useState(false);
	const [progress, setProgress] = useState(0);
	const { selectionRange } = useTimelineSelection();
	const { settings } = useSettings();

	const handleExport = async () => {
		if (!selectionRange?.frameIds.length) {
			toast({
				title: "No frames selected",
				description: "Please select frames to export",
				variant: "destructive",
			});
			return;
		}

		// Track export started
		posthog.capture("timeline_export_started", {
			frames_count: selectionRange.frameIds.length,
			selection_duration_ms: selectionRange.end.getTime() - selectionRange.start.getTime(),
		});

		setIsExporting(true);
		setProgress(0);
		try {
			let isClosingManually = false;
			let ws: WebSocket | null = null;

			const sortedFrameIds = selectionRange.frameIds.sort(
				(a, b) => parseInt(a) - parseInt(b),
			);

			// Helper function to safely close the WebSocket
			const closeWebSocket = () => {
				if (
					ws &&
					(ws.readyState === WebSocket.OPEN ||
						ws.readyState === WebSocket.CONNECTING)
				) {
					isClosingManually = true;
					try {
						ws.close();
					} catch (e) {
						console.error("Error closing WebSocket:", e);
					}
				}
				ws = null;
			};

			// Create WebSocket connection - send frame_ids in message body to avoid URL length limits
			ws = new WebSocket(
				`ws://localhost:3030/frames/export?fps=0.5`,
			);

			// Set a timeout to handle connection issues
			const connectionTimeout = setTimeout(() => {
				if (ws && ws.readyState !== WebSocket.OPEN) {
					toast({
						title: "Connection timeout",
						description: "Failed to connect to the server. Please try again.",
						variant: "destructive",
					});
					closeWebSocket();
					setIsExporting(false);
					setProgress(0);
				}
			}, 10000); // 10 seconds timeout

			ws.onopen = () => {
				clearTimeout(connectionTimeout);
				console.log("WebSocket connection established");
				// Send frame_ids in message body to avoid URL length limits
				ws?.send(JSON.stringify({ frame_ids: sortedFrameIds.map(id => parseInt(id)) }));
			};

			ws.onmessage = async (event) => {
				try {
					const data = JSON.parse(event.data);
					switch (data.status) {
						case "extracting":
							setProgress(data.progress * 100);
							break;
						case "encoding":
							setProgress(50 + data.progress * 50);
							break;
						case "completed":
							if (data.video_data) {
								closeWebSocket();
								const filename = `screenpipe_export_${new Date()
									.toISOString()
									.replace(/[:.]/g, "-")}.mp4`;

								try {
									if ("__TAURI__" in window) {
										const tauri = window.__TAURI__ as any;
										const { save } = tauri.dialog;
										const { writeFile } = tauri.fs;
										const filePath = await save({
											filters: [
												{
													name: "Video",
													extensions: ["mp4"],
												},
											],
											defaultPath: filename,
										});
										if (filePath) {
											await writeFile(
												filePath,
												new Uint8Array(data.video_data),
											);
											posthog.capture("timeline_export_completed", {
												frames_count: selectionRange?.frameIds.length,
											});
											toast({
												title: "Video exported",
												description:
													"Your video has been exported successfully",
											});
										}
									} else {
										// For browser (including Safari), handle the download differently
										const blob = new Blob([new Uint8Array(data.video_data)], {
											type: "video/mp4",
										});

										// Use a more Safari-friendly approach
										const url = window.URL.createObjectURL(blob);

										const a = document.createElement("a");
										a.href = url;
										a.download = filename;
										document.body.appendChild(a);
										a.click();
										window.URL.revokeObjectURL(url);
										a.remove();

										posthog.capture("timeline_export_completed", {
											frames_count: selectionRange?.frameIds.length,
										});
										toast({
											title: "Video exported",
											description: "Your video has been exported successfully",
										});
									}
								} catch (downloadError) {
									console.error("Download error:", downloadError);
									toast({
										title: "Download failed",
										description:
											"Failed to download the video. Please try again.",
										variant: "destructive",
									});
								}
							}
							setIsExporting(false);
							setProgress(0);
							break;
						case "error":
							toast({
								title: "Export failed",
								description: data.error || "Failed to export video",
								variant: "destructive",
							});
							setIsExporting(false);
							setProgress(0);
							closeWebSocket();
							break;
					}
				} catch (parseError) {
					console.error("Error parsing message:", parseError);
					toast({
						title: "Export failed",
						description: "Failed to process server response",
						variant: "destructive",
					});
					setIsExporting(false);
					setProgress(0);
					closeWebSocket();
				}
			};

			ws.onclose = (event) => {
				clearTimeout(connectionTimeout);
				console.log("WebSocket closed:", event);

				if (isExporting && !isClosingManually) {
					toast({
						title: "Connection closed",
						description: "The server connection was closed unexpectedly",
						variant: "destructive",
					});
					setIsExporting(false);
					setProgress(0);
				}
			};

			ws.onerror = (event) => {
				clearTimeout(connectionTimeout);
				// Only handle as a true error if we're not manually closing
				if (isClosingManually) {
					console.log(
						"WebSocket error during manual closure - this is expected",
					);
					return;
				}

				console.error("WebSocket error:", event);
				toast({
					title: "Export failed",
					description: "Connection error. Please try again.",
					variant: "destructive",
				});
				setIsExporting(false);
				setProgress(0);
				closeWebSocket();
			};
		} catch (error) {
			console.error("Export setup error:", error);
			toast({
				title: "Export failed",
				description: "Failed to export video. Please try again.",
				variant: "destructive",
			});
			setIsExporting(false);
			setProgress(0);
		}
	};

	const isDisabled = isExporting || !selectionRange?.frameIds.length;

	return (
		<button
			onClick={handleExport}
			disabled={isDisabled}
			className={cn(
				"w-full px-3 py-1.5 border border-border text-xs uppercase tracking-wide font-mono flex items-center justify-center gap-2 transition-colors duration-150",
				isDisabled
					? "bg-muted text-muted-foreground cursor-not-allowed"
					: "bg-background text-foreground hover:bg-foreground hover:text-background"
			)}
		>
			{isExporting ? (
				<>
					<Loader2 className="h-4 w-4 animate-spin" />
					<span>{progress > 0 ? `${Math.round(progress)}%` : "EXPORTING..."}</span>
				</>
			) : (
				<>
					<Video className="h-4 w-4" />
					<span>EXPORT VIDEO</span>
				</>
			)}
		</button>
	);
}
