import { createElement as h, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../core/i18n.ts";
import { CheckIcon, CloseIcon } from "../look/icons.ts";
import { sendsOnEnter } from "../shell/enter-key.ts";
import { createSource, heldCardKey } from "../shell/sources.ts";
import { useDockHold } from "./card-hold.ts";
import { CellEmpty } from "./cell-empty.ts";

// -------------------------------------------------------------------------
// Question cards. `ask_user` cards sit in the transcript and never block the Bot;
// typing in the composer instead answers them. The blocking ask_user_question tool
// keeps the shell's composer takeover and gains an own-answer field.

export const keyLetter = (index: number): string => String.fromCharCode(65 + index);
const optionsOf = (question: any): any[] =>
	(question?.options ?? []).map((option: any) => (typeof option === "string" ? { label: option } : option));
const isTypingTarget = (node: any): boolean =>
	node instanceof HTMLInputElement ||
	node instanceof HTMLTextAreaElement ||
	node instanceof HTMLSelectElement ||
	(node instanceof HTMLElement && node.isContentEditable);

// A bare letter picks that option and the letter after the last one
// jumps to the custom answer; never while typing or while a dialog is open.
// The listener is document-wide, so two open cards with letter keys would both
// answer the same key: each card registers here and the keys fire only while it
// is the sole registered card. The count also drives the key hints.
const optionKeyCards = createSource(0);
export function useOptionKeys(count: number, onPick: (index: number) => void, ownRef: any): boolean {
	const pick = useRef(onPick);
	pick.current = onPick;
	const listening = useSyncExternalStore(optionKeyCards.subscribe, optionKeyCards.getSnapshot);
	useEffect(() => {
		if (count === 0) return undefined;
		optionKeyCards.set((value: number) => value + 1);
		const onKey = (event: any): void => {
			if (
				event.defaultPrevented ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.shiftKey ||
				event.key.length !== 1
			)
				return;
			if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
			if (document.querySelector<any>('[role="dialog"], [aria-modal="true"]') !== null) return;
			if (optionKeyCards.getSnapshot() !== 1) return;
			const index = event.key.toUpperCase().charCodeAt(0) - 65;
			if (index >= 0 && index < count) {
				event.preventDefault();
				pick.current(index);
			} else if (index === count && ownRef.current) {
				event.preventDefault();
				ownRef.current.focus();
			}
		};
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			optionKeyCards.set((value: number) => value - 1);
		};
	}, [count, ownRef]);
	// Before the effect runs the card is not counted yet; read that as alone so a
	// lone card's hints never flicker on mount.
	return count > 0 && listening <= 1;
}

// A question shows two ways: as a bubble in the transcript, and raised when it
// sits in the dock above the composer.
function QuestionView({
	question,
	onAnswer,
	onDismiss,
	onInteract,
	busy = false,
	ownAnswer = false,
	raised = false,
	enterToSend = true,
}: any) {
	const [own, setOwn] = useState("");
	const [picked, setPicked] = useState<string[]>([]);
	const ownRef = useRef<any>(null);
	const titleId = useId();
	const options = optionsOf(question);
	const multi = question.multiSelect === true;
	const custom = own.trim();
	const canSubmit = multi ? picked.length > 0 || custom !== "" : custom !== "";
	const choose = (label: string): void => {
		if (busy) return;
		onInteract?.();
		if (multi) {
			setPicked((current) =>
				current.includes(label) ? current.filter((item) => item !== label) : [...current, label],
			);
			return;
		}
		onAnswer({ selected: [label] });
	};
	const submit = (): void => {
		if (!canSubmit || busy) return;
		onInteract?.();
		onAnswer({ selected: multi ? picked : [], ...(custom ? { custom } : {}) });
	};
	const hints = useOptionKeys(busy ? 0 : options.length, (index) => choose(options[index].label), ownRef);
	const ownLetter = options.length > 0 ? keyLetter(options.length) : undefined;
	const field = ownAnswer
		? h("textarea", {
				ref: ownRef,
				rows: 1,
				value: own,
				readOnly: busy,
				autoComplete: "off",
				spellCheck: false,
				className: "bt-q-input",
				"aria-label": t("Your own answer"),
				placeholder: t("Type your own answer"),
				"aria-keyshortcuts": hints ? ownLetter?.toLowerCase() : undefined,
				onChange: (event: any) => {
					if (!busy) {
						onInteract?.();
						setOwn(event.target.value);
					}
				},
				onKeyDown: (event: any) => {
					if (event.key !== "Enter" || !enterToSend || event.shiftKey || event.nativeEvent.isComposing) return;
					event.preventDefault();
					submit();
				},
			})
		: null;
	const rows = options.map((option: any, optionIndex: number) => {
		const selected = multi && picked.includes(option.label);
		return h(
			"button",
			{
				key: option.label,
				type: "button",
				className: "bt-q-opt",
				disabled: busy,
				"aria-pressed": multi ? selected : undefined,
				"aria-keyshortcuts": hints ? keyLetter(optionIndex).toLowerCase() : undefined,
				onClick: () => choose(option.label),
			},
			hints ? h("span", { className: "bt-key", "aria-hidden": true }, keyLetter(optionIndex)) : null,
			h(
				"span",
				{ className: "bt-q-body" },
				h("span", { className: "bt-q-label" }, option.label),
				option.description ? h("span", { className: "bt-q-desc" }, option.description) : null,
			),
			selected && !raised ? h("span", { className: "bt-q-check", title: t("Selected") }, h(CheckIcon)) : null,
		);
	});
	// Raised cards keep the custom answer as one more keyed row; bubbles put it below the list.
	if (raised && field) {
		rows.push(
			h(
				"label",
				{ key: "own", className: "bt-q-opt bt-q-ownrow", "data-filled": custom !== "" ? "" : undefined },
				hints && ownLetter ? h("span", { className: "bt-key", "aria-hidden": true }, ownLetter) : null,
				h("span", { className: "bt-q-body" }, field),
			),
		);
	}
	let foot = null;
	if (raised && multi) {
		foot = h(
			"div",
			{ className: "bt-q-foot" },
			h("button", { type: "button", className: "bt-q-btn", onClick: onDismiss, disabled: busy }, t("Skip")),
			h("button", { type: "submit", className: "bt-q-submit", disabled: !canSubmit || busy }, t("Submit")),
		);
	} else if ((raised || multi) && canSubmit) {
		foot = h(
			"div",
			{ className: "bt-q-foot" },
			h("button", { type: "submit", className: "bt-q-submit", disabled: busy }, t("Submit")),
		);
	}
	return h(
		"form",
		{
			className: raised ? "bt-q bt-q-raised" : "bt-q",
			"aria-labelledby": titleId,
			"aria-busy": busy || undefined,
			onFocusCapture: onInteract,
			onPointerDownCapture: onInteract,
			onSubmit: (event: any) => {
				event.preventDefault();
				submit();
			},
		},
		h(
			"div",
			{ className: "bt-q-head" },
			h(
				"div",
				{ className: "bt-q-text" },
				h(
					"p",
					{ className: "bt-q-title", id: titleId },
					question.header ? `${question.header} · ` : "",
					question.question,
				),
				question.detail ? h("div", { className: "bt-q-detail" }, question.detail) : null,
				raised && multi ? h("div", { className: "bt-q-detail" }, t("Choose all that apply")) : null,
			),
			h(
				"button",
				{
					type: "button",
					className: "bt-q-x",
					"aria-label": t("Dismiss question"),
					title: t("Dismiss"),
					onClick: onDismiss,
					disabled: busy,
				},
				h(CloseIcon),
			),
		),
		rows.length > 0 ? h("div", { className: "bt-q-list", role: "group" }, rows) : null,
		field && !raised
			? h(
					"div",
					{ className: "bt-q-custom" },
					h("label", { className: "bt-q-field" }, field),
					!multi && canSubmit
						? h("button", { type: "submit", className: "bt-q-submit", disabled: busy }, t("Submit"))
						: null,
				)
			: null,
		foot,
	);
}

// How a card closed without an answer on it reads on its badge.
export const closedLabel = (closed: string | undefined): string =>
	t(closed === "replied" ? "Answered by message" : "Dismissed");

// The settled card left in the transcript, read-only and compact: the question,
// muted, and only what the user chose, each under the letter it had on the card;
// an own answer takes the letter after the options. A card closed without an
// answer (`closed`, or no answer) keeps only the question and a badge.
export function SettledQuestion({ question, answer, closed }: any) {
	const options = optionsOf(question);
	const prompt = question?.question ?? "";
	const selected = Array.isArray(answer?.selected) ? answer.selected : [];
	const custom = typeof answer?.custom === "string" ? answer.custom.trim() : "";
	const answered = closed === undefined && (selected.length > 0 || custom !== "");
	const chosen = answered
		? [
				...selected.map((label: string) => ({
					label,
					at: options.findIndex((option: any) => option.label === label),
				})),
				...(custom !== "" ? [{ label: custom, at: options.length }] : []),
			]
		: [];
	return h(
		"div",
		{
			className: answered ? "bt-q bt-q-settled bt-q-answered" : "bt-q bt-q-settled bt-q-dismissed",
			role: "group",
			"aria-label": prompt,
		},
		h(
			"div",
			{ className: "bt-q-head" },
			h("div", { className: "bt-q-text" }, prompt ? h("p", { className: "bt-q-title" }, prompt) : null),
			answered ? null : h("span", { className: "bt-q-badge" }, closedLabel(closed)),
		),
		chosen.length > 0
			? h(
					"div",
					{ className: "bt-q-list", role: "group", "aria-label": t("Your answer") },
					chosen.map(({ label, at }: any, index: number) =>
						h(
							"div",
							{ key: `${label}-${index}`, className: "bt-q-opt", title: t("Selected") },
							at >= 0 ? h("span", { className: "bt-key", "aria-hidden": true }, keyLetter(at)) : null,
							h("span", { className: "bt-q-body" }, h("span", { className: "bt-q-label" }, label)),
						),
					),
				)
			: null,
	);
}

export function QuestionCard({ matched }: any) {
	const pending = matched;
	const questions = pending.questions ?? [];
	const [index, setIndex] = useState(0);
	const [answers, setAnswers] = useState<any[]>([]);
	const question = questions[index];
	if (question === undefined) return null;
	const onAnswer = (answer: any): void => {
		const next = [...answers, { id: question.id, ...answer }];
		if (index + 1 < questions.length) {
			setAnswers(next);
			setIndex(index + 1);
			return;
		}
		pending.answer({ answers: next });
	};
	return h(QuestionView, {
		key: index,
		question,
		onAnswer,
		onDismiss: () => pending.dismiss(),
		ownAnswer: true,
		raised: true,
	});
}

export function PendingQuestion({ sessionId, question, actions, inline, enterToSend = true }: any) {
	const [answered, setAnswered] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const busyRef = useRef(false);
	const hold = useDockHold(sessionId, "question", question.id, actions, inline);
	if (answered === question.id) return h(CellEmpty);
	const run = (make: () => Promise<unknown>): void => {
		if (busyRef.current) return;
		hold();
		busyRef.current = true;
		setBusy(true);
		// Keep QuestionView mounted until success: a failed request must not erase
		// the selected options, custom answer, or focused field.
		void Promise.resolve()
			.then(make)
			.then(
				() => setAnswered(question.id),
				() => setAnswered(null),
			)
			.finally(() => {
				busyRef.current = false;
				setBusy(false);
			});
	};
	const onAnswer = (answer: any): void =>
		run(() =>
			actions.answerQuestion(sessionId, question.id, {
				selected: answer.selected ?? [],
				custom: answer.custom ?? "",
			}),
		);
	const onDismiss = (): void => run(() => actions.dismissQuestion(sessionId));
	return h(
		"div",
		{ className: inline ? "bt-q-inline" : "bt-q-dock" },
		h(QuestionView, {
			key: question.id,
			question,
			onAnswer,
			onDismiss,
			onInteract: hold,
			busy,
			ownAnswer: question.allowCustom === true,
			raised: !inline,
			enterToSend,
		}),
	);
}

// Questions asked by a tool call render inline at that call (see ToolCell); the dock
// carries the ones whose call the transcript does not draw, including while history
// loads. A card the user starts editing stays in the dock until it closes.
export function QuestionDock({ sessionId, useRoster, useCards, useHeldCards, actions }: any) {
	const question = useRoster((value: any) => value.questions?.[sessionId]);
	const enterToSend = useRoster((value: any) => sendsOnEnter(value.prefs));
	const drawn = useCards?.((state: any) => state[sessionId]?.[question?.callId] > 0) === true;
	const held = useHeldCards?.((state: any) => state[sessionId]?.[heldCardKey("question", question?.id)] > 0) === true;
	if (question === undefined || (question.callId && drawn && !held)) return null;
	return h(PendingQuestion, {
		key: JSON.stringify([sessionId, question.id]),
		sessionId,
		question,
		actions,
		inline: false,
		enterToSend,
	});
}

// An answered card in the transcript: the question stays where it was asked, with the
// answer marked.
export function AnsweredCell({ node }: any) {
	const data = node.data ?? {};
	// The reply text is ocean-crew's own payload and keeps each question's options; the
	// pairs DSH reads out of it may drop them.
	let sent: any = null;
	try {
		sent = typeof data.text === "string" ? JSON.parse(data.text) : null;
	} catch {
		sent = null;
	}
	const asked = Array.isArray(sent?.questions)
		? sent.questions.filter((item: any) => typeof item?.id === "string" && typeof item.question === "string")
		: [];
	const questions = (Array.isArray(data.questions) ? data.questions : []).map((question: any) => ({
		...asked.find((item: any) => item.id === question.id),
		...question,
	}));
	if (questions.length === 0) {
		return data.text
			? h("div", { className: "bt-urow" }, h("div", { className: "bt-ububble" }, data.text))
			: h(CellEmpty);
	}
	const answers = Array.isArray(data.answers) ? data.answers : [];
	return h(
		"div",
		{ className: "bt-q-inline" },
		questions.map((question: any) =>
			h(SettledQuestion, {
				key: question.id,
				question,
				answer: answers.find((answer: any) => answer.id === question.id) ?? { selected: [] },
			}),
		),
	);
}
