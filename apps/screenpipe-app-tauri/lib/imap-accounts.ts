// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

interface ImapAccount {
  instance: string | null;
  connected: boolean;
  credentials?: { username?: string; imap_host?: string; imap_port?: string };
}

export async function readImapAccounts(response: Response) {
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.instances)) {
    throw new Error("Could not load email accounts.");
  }
  const accounts: ImapAccount[] = data.instances.filter((account: ImapAccount) => account.connected);
  const usernameCounts = new Map<string, number>();
  for (const account of accounts) {
    const username = account.credentials?.username;
    if (username) usernameCounts.set(username, (usernameCounts.get(username) || 0) + 1);
  }
  return accounts.map((account) => {
    const username = account.credentials?.username;
    const host = account.credentials?.imap_host;
    const sameUsername = username && (usernameCounts.get(username) || 0) > 1;
    const server = sameUsername && host ? `${host}:${account.credentials?.imap_port || "993"}` : undefined;
    return { instance: account.instance, username, server };
  });
}
