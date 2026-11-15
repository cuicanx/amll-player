import { createRoot } from "react-dom/client";
import { ErrorBoundary, type FallbackProps } from "react-error-boundary";
import { TaskbarLyricApp } from "./pages/taskbar-lyric/index.tsx";
import { toError } from "./utils/error.ts";

const ErrorRender = (props: FallbackProps) => {
	console.error(props.error);
	const normalizedError = toError(props.error);

	return (
		<div>
			<h2>An unrecoverable error has occured</h2>
			<code>
				<pre>
					{normalizedError.message}
					{"\n"}
					{normalizedError.stack}
				</pre>
			</code>
		</div>
	);
};

createRoot(document.getElementById("root") as HTMLElement).render(
	<ErrorBoundary fallbackRender={ErrorRender}>
		<TaskbarLyricApp />
	</ErrorBoundary>,
);

// The native side owns visibility: it creates the window hidden, embeds it
// into the taskbar and only then shows it (with its own timeout as a safety
// net). Revealing it from here as well meant the window could become visible
// before the embed/positioning pass finished, which is what produced the
// "window pops up, then disappears" flash on startup.
