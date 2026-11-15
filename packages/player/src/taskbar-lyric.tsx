import { getCurrentWindow } from "@tauri-apps/api/window";
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

// The native window is created hidden and embedded into the taskbar right
// after creation. Reveal it only once React has painted, so the control never
// appears first as an empty transparent frame. `show()` is idempotent, so the
// timer simply covers the case where the frames were throttled.
const reveal = () => {
	getCurrentWindow()
		.show()
		.catch((err) => console.warn("显示任务栏歌词窗口失败", err));
};
requestAnimationFrame(() => requestAnimationFrame(reveal));
window.setTimeout(reveal, 300);
