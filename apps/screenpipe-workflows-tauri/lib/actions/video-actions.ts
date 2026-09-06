import { commands } from "@/lib/utils/tauri";

export async function getMediaFile(
	filePath: string,
): Promise<{ data: string; mimeType: string }> {
	try {
		const res = await commands.getMediaFile(filePath);
		if (res.status === "error") throw new Error(res.error);
		return res.data as { data: string; mimeType: string };
	} catch (error) {
		console.error("failed to read media file:", error);
		const message = error instanceof Error ? error.message : String(error || "unknown error");
		throw new Error(
			`failed to read media file: ${message}`,
		);
	}
}
