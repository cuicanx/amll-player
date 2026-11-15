import { musicQualityAtom } from "@applemusic-like-lyrics/react-full";
import { Button, Dialog } from "@radix-ui/themes";
import { useAtom, useAtomValue } from "jotai";
import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { audioQualityDialogOpenedAtom } from "../../states/appAtoms";
import styles from "./index.module.css";

const CrossIcon: FC = () => (
	<svg
		width="12"
		height="12"
		viewBox="0 0 12 12"
		fill="none"
		aria-hidden="true"
	>
		<title>Close</title>
		<path
			d="M1 1L11 11M11 1L1 11"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
		/>
	</svg>
);

const formatSampleRate = (value: number | null | undefined): string => {
	if (typeof value !== "number" || !Number.isFinite(value)) return "—";
	return value.toLocaleString("en-US");
};

/**
 * Audio decoding information.
 *
 * Rows are rendered from a data array instead of a Radix DataList: the list
 * used to drop the label cell of the "channels" row (the label was not wrapped
 * in `DataList.Label`), which broke the column alignment of the whole table.
 * A plain grid keeps every row aligned and lets the value column use tabular
 * numerals so numbers line up regardless of length.
 */
export const AudioQualityDialog: FC = () => {
	const { t } = useTranslation();
	const [audioQualityDialogOpened, setAudioQualityDialogOpened] = useAtom(
		audioQualityDialogOpenedAtom,
	);
	const musicQuality = useAtomValue(musicQualityAtom);

	const rows: { key: string; label: string; value: string; unit?: string }[] = [
		{
			key: "codec",
			label: t("amll.audioQuality.codec", "音频解码器"),
			value: (musicQuality.codec || "—").toUpperCase(),
		},
		{
			key: "channels",
			label: t("amll.audioQuality.channels", "音频通道数量"),
			value: String(musicQuality.channels ?? "—"),
			unit: t("amll.audioQuality.channelUnit", "声道"),
		},
		{
			key: "sampleRate",
			label: t("amll.audioQuality.sampleRate", "采样率"),
			value: formatSampleRate(musicQuality.sampleRate),
			unit: "Hz",
		},
		{
			key: "sampleFormat",
			label: t("amll.audioQuality.sampleFormat", "采样格式"),
			value: (musicQuality.sampleFormat || "—").toLowerCase(),
		},
	];

	return (
		<Dialog.Root
			open={audioQualityDialogOpened}
			onOpenChange={setAudioQualityDialogOpened}
		>
			<Dialog.Content className={styles.content} aria-describedby={undefined}>
				<div className={styles.header}>
					<div className={styles.heading}>
						<Dialog.Title className={styles.title}>
							{t("amll.audioQuality.title", "音频解码信息")}
						</Dialog.Title>
						<span className={styles.subtitle}>
							{t("amll.audioQuality.subtitle", "当前播放音频的实际解码参数")}
						</span>
					</div>
					<Dialog.Close>
						<button
							type="button"
							className={styles.closeButton}
							aria-label={t("common.dialog.close", "关闭")}
						>
							<CrossIcon />
						</button>
					</Dialog.Close>
				</div>

				<div className={styles.rows}>
					{rows.map((row) => (
						<div className={styles.row} key={row.key}>
							<span className={styles.label}>{row.label}</span>
							<span className={styles.value}>
								{row.value}
								{row.unit ? (
									<span className={styles.unit}>{row.unit}</span>
								) : null}
							</span>
						</div>
					))}
				</div>

				<div className={styles.footer}>
					<Dialog.Close>
						<Button variant="soft" size="2">
							{t("common.dialog.close", "关闭")}
						</Button>
					</Dialog.Close>
				</div>
			</Dialog.Content>
		</Dialog.Root>
	);
};
