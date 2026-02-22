// REPLACING:
// Format relative time
function formatRelativeTime(timestamp: string): string {

// NEW CODE - add highlightText BEFORE formatRelativeTime:

function highlightText(text: string, query: string): React.ReactNode {
  if (!query || !text) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escaped})`, "gi");
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-yellow-300 text-yellow-900 dark:bg-yellow-500 dark:text-yellow-950 rounded px-0.5">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

// Format relative time
function formatRelativeTime(timestamp: string): string {