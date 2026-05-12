"use client";

import * as React from "react";
import {
	Activity,
	CheckCircle2,
	Copy,
	Inbox,
	Loader2,
	RefreshCw,
	Terminal,
	Trash2,
	XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type WebhookEvent = {
	id: string;
	method: string;
	path: string;
	query: Record<string, string>;
	headers: Record<string, string>;
	body: string;
	bodySize: number;
	contentType: string | null;
	receivedAt: number;
	remoteAddr: string | null;
};

type Status = "connecting" | "open" | "expired" | "error";

const STORAGE_KEY = "hook:session";

type StoredSession = {
	id: string;
	expiresAt: number;
	events: WebhookEvent[];
};

function generateId(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function loadSession(): StoredSession | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as StoredSession;
		if (
			typeof parsed.id !== "string" ||
			typeof parsed.expiresAt !== "number" ||
			!Array.isArray(parsed.events)
		) {
			return null;
		}
		if (parsed.expiresAt <= Date.now()) return null;
		return parsed;
	} catch {
		return null;
	}
}

function saveSession(s: StoredSession) {
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
	} catch {}
}

function clearStoredSession() {
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {}
}

function formatTimeLeft(ms: number): string {
	if (ms <= 0) return "00:00";
	const total = Math.floor(ms / 1000);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => n.toString().padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatClock(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

function formatBytes(n: number): string {
	if (n === 0) return "0 B";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function methodColor(method: string): string {
	switch (method.toUpperCase()) {
		case "GET":
			return "bg-sky-500/15 text-sky-700 dark:text-sky-300";
		case "POST":
			return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
		case "PUT":
			return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
		case "PATCH":
			return "bg-violet-500/15 text-violet-700 dark:text-violet-300";
		case "DELETE":
			return "bg-rose-500/15 text-rose-700 dark:text-rose-300";
		default:
			return "bg-zinc-500/15 text-zinc-700 dark:text-zinc-300";
	}
}

function tryParseJSON(text: string): unknown | undefined {
	if (!text) return undefined;
	const trimmed = text.trim();
	if (
		!(trimmed.startsWith("{") || trimmed.startsWith("["))
	)
		return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function CopyButton({
	value,
	label = "Copy",
	className,
	size = "sm",
}: {
	value: string;
	label?: string;
	className?: string;
	size?: "sm" | "default" | "icon";
}) {
	const [copied, setCopied] = React.useState(false);
	const onCopy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {}
	};
	return (
		<Button
			variant="outline"
			size={size}
			onClick={onCopy}
			className={className}
			aria-label={label}
		>
			{copied ? <CheckCircle2 className="text-emerald-500" /> : <Copy />}
			{size !== "icon" && (
				<span>{copied ? "Copied" : label}</span>
			)}
		</Button>
	);
}

function StatusDot({ status }: { status: Status }) {
	const map: Record<Status, { color: string; label: string }> = {
		connecting: { color: "bg-amber-500", label: "Connecting" },
		open: { color: "bg-emerald-500", label: "Listening" },
		expired: { color: "bg-zinc-400", label: "Expired" },
		error: { color: "bg-rose-500", label: "Disconnected" },
	};
	const { color, label } = map[status];
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			<span className="relative flex h-2 w-2">
				{status === "open" && (
					<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/60" />
				)}
				<span className={cn("relative inline-flex h-2 w-2 rounded-full", color)} />
			</span>
			<span>{label}</span>
		</div>
	);
}

export function WebhookTool() {
	const [origin, setOrigin] = React.useState<string>("");
	const [sessionId, setSessionId] = React.useState<string | null>(null);
	const [expiresAt, setExpiresAt] = React.useState<number | null>(null);
	const [events, setEvents] = React.useState<WebhookEvent[]>([]);
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [status, setStatus] = React.useState<Status>("connecting");
	const [now, setNow] = React.useState(() => Date.now());
	const esRef = React.useRef<EventSource | null>(null);
	const expiresAtRef = React.useRef<number | null>(null);

	React.useEffect(() => {
		expiresAtRef.current = expiresAt;
	}, [expiresAt]);

	React.useEffect(() => {
		setOrigin(window.location.origin);
		const existing = loadSession();
		if (existing) {
			setSessionId(existing.id);
			setExpiresAt(existing.expiresAt);
			setEvents(existing.events);
			setSelectedId(existing.events[0]?.id ?? null);
		} else {
			const id = generateId();
			setSessionId(id);
		}
	}, []);

	// Only re-create the EventSource when the session id changes. Reading
	// expiresAt through a ref avoids re-running this effect on every received
	// hook (and re-running on status changes would create an infinite
	// connecting/open flip).
	React.useEffect(() => {
		if (!sessionId) return;

		const es = new EventSource(`/s/${sessionId}`);
		esRef.current = es;
		setStatus("connecting");

		es.addEventListener("open", () => {
			setStatus("open");
		});

		es.addEventListener("init", (e) => {
			try {
				const data = JSON.parse((e as MessageEvent).data) as {
					expiresAt: number;
				};
				setExpiresAt(data.expiresAt);
				setStatus("open");
			} catch {}
		});

		es.addEventListener("hook", (e) => {
			try {
				const data = JSON.parse((e as MessageEvent).data) as {
					event: WebhookEvent;
					expiresAt: number;
				};
				setExpiresAt(data.expiresAt);
				setEvents((prev) => [data.event, ...prev]);
				setSelectedId((prev) => prev ?? data.event.id);
			} catch {}
		});

		es.addEventListener("expired", () => {
			setStatus("expired");
			es.close();
		});

		es.onerror = () => {
			const exp = expiresAtRef.current;
			if (exp !== null && Date.now() >= exp) {
				setStatus("expired");
				es.close();
			} else if (es.readyState === EventSource.CLOSED) {
				setStatus("error");
			}
		};

		return () => {
			es.close();
			esRef.current = null;
		};
	}, [sessionId]);

	React.useEffect(() => {
		if (!sessionId || expiresAt === null) return;
		saveSession({ id: sessionId, expiresAt, events });
	}, [sessionId, expiresAt, events]);

	React.useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	React.useEffect(() => {
		if (
			status !== "expired" &&
			expiresAt !== null &&
			now >= expiresAt
		) {
			setStatus("expired");
			esRef.current?.close();
		}
	}, [now, expiresAt, status]);

	const endpointUrl =
		origin && sessionId ? `${origin}/h/${sessionId}` : "";
	const timeLeft =
		expiresAt !== null ? Math.max(0, expiresAt - now) : 0;
	const selected =
		events.find((e) => e.id === selectedId) ?? events[0] ?? null;

	const curlSnippet = endpointUrl
		? `curl -X POST ${endpointUrl} \\\n  -H "Content-Type: application/json" \\\n  -d '{"message":"Hello, world!"}'`
		: "";

	const handleNewSession = () => {
		esRef.current?.close();
		clearStoredSession();
		setEvents([]);
		setSelectedId(null);
		setExpiresAt(null);
		setStatus("connecting");
		setSessionId(generateId());
	};

	const handleClear = () => {
		setEvents([]);
		setSelectedId(null);
	};

	return (
		<div className="min-h-screen flex flex-col">
			<header className="border-b bg-background/80 backdrop-blur sticky top-0 z-10">
				<div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center gap-3">
					<div className="flex items-center gap-2 font-semibold tracking-tight">
						<div className="relative">
							<div className="absolute inset-0 rounded-md bg-primary/20 blur-md" />
							<div className="relative grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
								<Activity className="h-4 w-4" />
							</div>
						</div>
						<span>Hook</span>
						<span className="text-xs font-normal text-muted-foreground hidden sm:inline">
							disposable webhook receiver
						</span>
					</div>
					<div className="ml-auto flex items-center gap-3">
						<StatusDot status={status} />
						<Separator />
						<div
							className={cn(
								"font-mono text-sm tabular-nums",
								status === "expired"
									? "text-muted-foreground line-through"
									: timeLeft < 5 * 60 * 1000
										? "text-amber-600 dark:text-amber-400"
										: "",
							)}
							title="Time until endpoint expires"
						>
							{status === "expired" ? "expired" : formatTimeLeft(timeLeft)}
						</div>
					</div>
				</div>
			</header>

			<main className="mx-auto w-full max-w-6xl flex-1 px-4 sm:px-6 py-6 space-y-6">
				<EndpointBar
					url={endpointUrl}
					expired={status === "expired"}
					onNewSession={handleNewSession}
				/>

				<div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
					<RequestList
						events={events}
						selectedId={selected?.id ?? null}
						onSelect={setSelectedId}
						onClear={handleClear}
						expired={status === "expired"}
					/>
					<div className="min-w-0">
						{events.length === 0 ? (
							<EmptyState
								endpointUrl={endpointUrl}
								curl={curlSnippet}
								expired={status === "expired"}
							/>
						) : selected ? (
							<RequestDetail event={selected} />
						) : null}
					</div>
				</div>

				<footer className="pt-2 pb-6 flex flex-wrap items-center gap-x-4 gap-y-2">
					<div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
						<span>Payloads stay in this tab — nothing is stored on the server.</span>
						<span className="opacity-60">·</span>
						<span>Endpoint expires 60 min after the last received request.</span>
					</div>
					<Button
						variant="outline"
						size="sm"
						onClick={handleNewSession}
						className="ml-auto"
					>
						<RefreshCw />
						<span>New URL</span>
					</Button>
				</footer>
			</main>
		</div>
	);
}

function Separator() {
	return <div className="h-4 w-px bg-border" />;
}

function EndpointBar({
	url,
	expired,
	onNewSession,
}: {
	url: string;
	expired: boolean;
	onNewSession: () => void;
}) {
	return (
		<Card className={cn(expired && "opacity-70")}>
			<CardContent className="p-3 sm:p-4">
				<div className="flex flex-col gap-2">
					<label className="text-xs font-medium text-muted-foreground">
						Your webhook endpoint
					</label>
					<div className="flex items-stretch gap-2">
						<div className="flex-1 min-w-0 rounded-md border bg-muted/40 font-mono text-sm overflow-hidden">
							<input
								readOnly
								value={url}
								onFocus={(e) => e.currentTarget.select()}
								className="w-full bg-transparent px-3 py-2 outline-none truncate"
								aria-label="Webhook endpoint URL"
							/>
						</div>
						<CopyButton value={url} label="Copy URL" />
						{expired && (
							<Button onClick={onNewSession} variant="default">
								<RefreshCw />
								<span>New URL</span>
							</Button>
						)}
					</div>
					{expired && (
						<p className="text-xs text-muted-foreground">
							This endpoint has expired. Generate a new URL to keep testing.
						</p>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

function RequestList({
	events,
	selectedId,
	onSelect,
	onClear,
	expired,
}: {
	events: WebhookEvent[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	onClear: () => void;
	expired: boolean;
}) {
	return (
		<Card className="overflow-hidden">
			<CardHeader className="flex-row items-center justify-between space-y-0 py-3">
				<div className="flex items-center gap-2">
					<Inbox className="h-4 w-4 text-muted-foreground" />
					<CardTitle className="text-sm">
						Requests
						<span className="ml-1.5 text-muted-foreground font-normal">
							({events.length})
						</span>
					</CardTitle>
				</div>
				{events.length > 0 && (
					<Button
						variant="ghost"
						size="sm"
						onClick={onClear}
						className="text-muted-foreground hover:text-foreground -mr-2"
					>
						<Trash2 className="h-3.5 w-3.5" />
					</Button>
				)}
			</CardHeader>
			<div className="border-t max-h-[60vh] lg:max-h-[70vh] overflow-y-auto">
				{events.length === 0 ? (
					<div className="p-6 text-center text-sm text-muted-foreground">
						{expired ? (
							<>Session expired.</>
						) : (
							<>
								<Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin opacity-50" />
								Waiting for requests…
							</>
						)}
					</div>
				) : (
					<ul className="divide-y">
						{events.map((e) => {
							const isSelected = e.id === selectedId;
							return (
								<li key={e.id}>
									<button
										onClick={() => onSelect(e.id)}
										className={cn(
											"w-full text-left px-3 py-2 flex flex-col gap-1 transition-colors",
											"hover:bg-accent/60",
											isSelected && "bg-accent",
										)}
									>
										<div className="flex items-center gap-2 min-w-0 w-full">
											<span
												className={cn(
													"inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wide font-mono shrink-0",
													methodColor(e.method),
												)}
											>
												{e.method}
											</span>
											<span
												className="font-mono text-xs truncate min-w-0"
												title={e.path}
											>
												{e.path}
											</span>
										</div>
										<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
											<span className="font-mono tabular-nums">
												{formatClock(e.receivedAt)}
											</span>
											<span className="ml-auto tabular-nums">
												{formatBytes(e.bodySize)}
											</span>
										</div>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</Card>
	);
}

function EmptyState({
	endpointUrl,
	curl,
	expired,
}: {
	endpointUrl: string;
	curl: string;
	expired: boolean;
}) {
	if (expired) {
		return (
			<Card>
				<CardContent className="p-10 flex flex-col items-center text-center gap-3">
					<XCircle className="h-8 w-8 text-muted-foreground" />
					<div className="font-medium">No requests were received</div>
					<p className="text-sm text-muted-foreground max-w-md">
						This endpoint has expired. Generate a new URL above to start a fresh session.
					</p>
				</CardContent>
			</Card>
		);
	}
	return (
		<Card>
			<CardContent className="p-6 sm:p-8 space-y-5">
				<div className="flex items-start gap-3">
					<div className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary">
						<Terminal className="h-4 w-4" />
					</div>
					<div className="space-y-1">
						<div className="font-medium">
							Ready to receive webhooks
						</div>
						<p className="text-sm text-muted-foreground">
							Send a request to{" "}
							<code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
								{endpointUrl}
							</code>{" "}
							and it will appear here in real time.
						</p>
					</div>
				</div>
				<div className="space-y-2">
					<div className="flex items-center justify-between">
						<label className="text-xs font-medium text-muted-foreground">
							Or try a quick test
						</label>
						<CopyButton value={curl} label="Copy curl" />
					</div>
					<pre className="rounded-md border bg-muted/40 px-3 py-2.5 text-xs font-mono overflow-x-auto leading-relaxed">
						{curl}
					</pre>
				</div>
			</CardContent>
		</Card>
	);
}

function RequestDetail({ event }: { event: WebhookEvent }) {
	const queryEntries = Object.entries(event.query);
	const headerEntries = Object.entries(event.headers).sort(([a], [b]) =>
		a.localeCompare(b),
	);

	return (
		<Card className="overflow-hidden">
			<CardHeader className="border-b py-3">
				<div className="flex items-start justify-between gap-3">
					<div className="flex items-center gap-2 min-w-0">
						<span
							className={cn(
								"inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide font-mono shrink-0",
								methodColor(event.method),
							)}
						>
							{event.method}
						</span>
						<code className="truncate font-mono text-sm">
							{event.path}
						</code>
					</div>
					<div className="text-xs text-muted-foreground tabular-nums shrink-0">
						{formatClock(event.receivedAt)}
					</div>
				</div>
				<div className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
					{event.remoteAddr && (
						<span>
							from <code className="font-mono">{event.remoteAddr}</code>
						</span>
					)}
					<span>{formatBytes(event.bodySize)}</span>
					{event.contentType && (
						<span className="truncate">{event.contentType}</span>
					)}
				</div>
			</CardHeader>
			<CardContent className="p-0">
				{queryEntries.length > 0 && (
					<Section title={`Query (${queryEntries.length})`}>
						<KeyValueList entries={queryEntries} />
					</Section>
				)}
				<Section title={`Headers (${headerEntries.length})`}>
					<KeyValueList entries={headerEntries} />
				</Section>
				<Section title="Body" trailing={<BodyMeta event={event} />}>
					<BodyView event={event} />
				</Section>
			</CardContent>
		</Card>
	);
}

function Section({
	title,
	trailing,
	children,
}: {
	title: string;
	trailing?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="border-t first:border-t-0">
			<div className="px-4 py-2 flex items-center justify-between bg-muted/30">
				<h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					{title}
				</h3>
				{trailing}
			</div>
			<div>{children}</div>
		</section>
	);
}

function KeyValueList({ entries }: { entries: [string, string][] }) {
	return (
		<dl className="divide-y">
			{entries.map(([k, v]) => (
				<div
					key={k}
					className="grid grid-cols-[minmax(120px,200px)_1fr] gap-3 px-4 py-2 text-xs"
				>
					<dt className="font-mono text-muted-foreground truncate" title={k}>
						{k}
					</dt>
					<dd className="font-mono break-all whitespace-pre-wrap">{v}</dd>
				</div>
			))}
		</dl>
	);
}

function BodyMeta({ event }: { event: WebhookEvent }) {
	const parsed = tryParseJSON(event.body);
	const ct = event.contentType?.toLowerCase() ?? "";
	let label: string;
	if (event.body.length === 0) label = "empty";
	else if (parsed !== undefined) label = "JSON";
	else if (ct.includes("x-www-form-urlencoded")) label = "form";
	else if (ct.includes("xml")) label = "XML";
	else if (ct.includes("text/")) label = "text";
	else if (ct) label = ct.split(";")[0];
	else label = "raw";
	return (
		<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
			<Badge variant="outline" className="text-[10px] py-0 px-1.5">
				{label}
			</Badge>
			<CopyButton
				value={event.body}
				label="Copy"
				className="h-7 px-2 text-[11px]"
			/>
		</div>
	);
}

function BodyView({ event }: { event: WebhookEvent }) {
	if (event.body.length === 0) {
		return (
			<div className="px-4 py-6 text-xs text-muted-foreground italic">
				(empty body)
			</div>
		);
	}
	const parsed = tryParseJSON(event.body);
	if (parsed !== undefined) {
		return (
			<pre className="px-4 py-3 text-xs font-mono overflow-x-auto leading-relaxed">
				<JSONView value={parsed} />
			</pre>
		);
	}
	const ct = event.contentType?.toLowerCase() ?? "";
	if (ct.includes("x-www-form-urlencoded")) {
		try {
			const params = new URLSearchParams(event.body);
			const entries = [...params.entries()];
			if (entries.length > 0) return <KeyValueList entries={entries} />;
		} catch {}
	}
	return (
		<pre className="px-4 py-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
			{event.body}
		</pre>
	);
}

function JSONView({ value }: { value: unknown }): React.ReactElement {
	return <>{renderJSON(value, 0)}</>;
}

function renderJSON(
	value: unknown,
	depth: number,
	key?: string,
): React.ReactNode {
	const indent = "  ".repeat(depth);
	const keyPart = key !== undefined ? (
		<>
			<span className="text-sky-600 dark:text-sky-300">{JSON.stringify(key)}</span>
			<span className="text-muted-foreground">: </span>
		</>
	) : null;

	if (value === null) {
		return (
			<span>
				{indent}
				{keyPart}
				<span className="text-rose-500">null</span>
			</span>
		);
	}
	if (typeof value === "string") {
		return (
			<span>
				{indent}
				{keyPart}
				<span className="text-emerald-600 dark:text-emerald-300">
					{JSON.stringify(value)}
				</span>
			</span>
		);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return (
			<span>
				{indent}
				{keyPart}
				<span className="text-amber-600 dark:text-amber-300">{String(value)}</span>
			</span>
		);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return (
				<span>
					{indent}
					{keyPart}
					<span className="text-muted-foreground">[]</span>
				</span>
			);
		}
		return (
			<span>
				{indent}
				{keyPart}
				<span className="text-muted-foreground">{"["}</span>
				{"\n"}
				{value.map((v, i) => (
					<React.Fragment key={i}>
						{renderJSON(v, depth + 1)}
						{i < value.length - 1 ? (
							<span className="text-muted-foreground">,</span>
						) : null}
						{"\n"}
					</React.Fragment>
				))}
				{indent}
				<span className="text-muted-foreground">{"]"}</span>
			</span>
		);
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			return (
				<span>
					{indent}
					{keyPart}
					<span className="text-muted-foreground">{"{}"}</span>
				</span>
			);
		}
		return (
			<span>
				{indent}
				{keyPart}
				<span className="text-muted-foreground">{"{"}</span>
				{"\n"}
				{entries.map(([k, v], i) => (
					<React.Fragment key={k}>
						{renderJSON(v, depth + 1, k)}
						{i < entries.length - 1 ? (
							<span className="text-muted-foreground">,</span>
						) : null}
						{"\n"}
					</React.Fragment>
				))}
				{indent}
				<span className="text-muted-foreground">{"}"}</span>
			</span>
		);
	}
	return <span>{String(value)}</span>;
}
