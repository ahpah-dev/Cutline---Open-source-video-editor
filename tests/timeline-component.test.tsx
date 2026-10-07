import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, useReducer, useState } from "react";
import { createRoot } from "react-dom/client";
import { Timeline } from "../app/editor/Timeline";
import { historyReducer } from "../app/editor/useProject";
import { waveformColumns } from "../app/editor/waveform";
import { makeClip, migrateProject, newProject, projectDuration, setJoinTransition, type Project, type Selection, type TransitionName } from "../app/editor/model";
import { sampleProject } from "./fixtures";
import { alignSelectionToPlayhead, detachClipAudio, removeSelection } from "../app/editor/timelineOperations";

test("detached video audio preserves source timing, automation, and one-step undo", () => {
  const project = newProject();
  const video = { id: "source", name: "Take.mp4", kind: "video" as const, duration: 30, sizeLabel: "1 MB", theme: "video" };
  const clip = { ...makeClip(video, 12, 2), sourceStart: 4, sourceEnd: 16, speed: 2, volume: 0.75,
    propertyKeyframes: { volume: [{ time: 0, value: 0.2, easing: "linear" as const }, { time: 6, value: 0.8, easing: "linear" as const }] } };
  project.assets = [video];
  project.clips = [clip];
  const result = detachClipAudio(project, clip.id);
  const audio = result.project.clips.at(-1)!;
  assert.equal(audio.kind, "audio");
  assert.equal(audio.assetId, video.id);
  assert.equal(audio.start, 12);
  assert.deepEqual([audio.sourceStart, audio.sourceEnd, audio.speed], [4, 16, 2]);
  const restored = migrateProject(result.project, result.project.assets);
  const restoredAudio = restored.clips.find((item) => item.id === audio.id)!;
  assert.equal(restoredAudio.kind, "audio", "Detached video audio must remain audio after reopening or backup restoration");
  assert.deepEqual([restoredAudio.sourceStart, restoredAudio.sourceEnd, restoredAudio.speed], [4, 16, 2]);
  assert.deepEqual(audio.propertyKeyframes?.volume, clip.propertyKeyframes.volume);
  assert.equal(result.project.clips[0].volume, 0);
  assert.equal(result.project.clips[0].propertyKeyframes?.volume, undefined);
  assert.equal(project.clips[0].volume, 0.75, "Detachment must not mutate the source project");
  const edited = historyReducer({ project, past: [], future: [], origin: null, group: "", at: 0 },
    { type: "edit", fn: () => result.project, group: "", at: 1 });
  assert.equal(historyReducer(edited, { type: "undo" }).project, project);
  project.lockedTracks = ["layer:2"];
  assert.equal(detachClipAudio(project, clip.id).project, project);
});

test("group alignment preserves offsets, and locked layers survive ripple deletion", () => {
  const project = newProject();
  const video = { id: "source", name: "Take.mp4", kind: "video" as const, duration: 30, sizeLabel: "1 MB", theme: "video" };
  project.assets = [video];
  project.clips = [
    { ...makeClip(video, 2, 1), id: "a", sourceEnd: 3 },
    { ...makeClip(video, 4, 1), id: "b", sourceEnd: 3 },
    { ...makeClip(video, 8, 1), id: "c", sourceEnd: 2 },
    { ...makeClip(video, 2, 0), id: "locked", sourceEnd: 5 },
  ];
  const selected = [{ kind: "clip" as const, id: "a" }, { kind: "clip" as const, id: "b" }];
  const aligned = alignSelectionToPlayhead(project, selected, 20, "end");
  assert.deepEqual(aligned.clips.slice(0, 2).map((clip) => clip.start), [15, 17]);
  assert.equal(alignSelectionToPlayhead(project, selected, 0, "end").clips[1].start, 2, "Moving to zero must keep group spacing");
  project.lockedTracks = ["layer:0"];
  const deleted = removeSelection(project, [...selected, { kind: "clip", id: "locked" }], true);
  assert.equal(deleted.clips.find((clip) => clip.id === "c")!.start, 3, "Overlapping deleted gaps must be counted once");
  assert.deepEqual(deleted.clips.find((clip) => clip.id === "locked"), project.clips[3]);
  assert.equal(alignSelectionToPlayhead(project, [{ kind: "clip", id: "locked" }], 15, "start"), project);
});

test("Timeline component: exact drag, cross-track move, trim, zoom, cancel, and undo", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://unit.test",
  });
  const { window } = dom;
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let nextFrame = 1;
  const frames = new Map<number, FrameRequestCallback>();
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextFrame++;
    frames.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  let captures = 0;
  window.HTMLElement.prototype.setPointerCapture = function () {
    assert.ok(
      this.classList.contains("timeline"),
      "Capture must survive clip reparenting",
    );
    captures++;
  };
  window.HTMLElement.prototype.releasePointerCapture = () => {};
  const initial = sampleProject();
  let observed = initial,
    selected: Selection = null;
  let selectedMany: NonNullable<Selection>[] = [];
  let lastMenuAction = "";
  let lastTransitionTarget: string | null = null;
  let openedTransitionId = "";
  let load: (project: Project) => void = () => {};
  let setDragTransition: (name: TransitionName | null) => void = () => {};
  function Harness() {
    const [s, dispatch] = useReducer(historyReducer, {
      project: initial,
      past: [],
      future: [],
      origin: null,
      group: "",
      at: 0,
    });
    const [selection, setSelection] = useState<Selection>(null),
      [multi, setMulti] = useState<NonNullable<Selection>[]>([]),
      [time, seek] = useState(0);
    const select = (value: Selection) => { setSelection(value); setMulti(value ? [value] : []); };
    const selectMany = (values: NonNullable<Selection>[]) => { setMulti(values); setSelection(values.at(-1) ?? null); };
    const [draggingTransition, setDraggingTransition] = useState<TransitionName | null>(null);
    setDragTransition = setDraggingTransition;
    observed = s.project;
    selected = selection;
    selectedMany = multi;
    load = (project) => { dispatch({ type: "load", project }); seek(0); };
    const edit = (fn: (p: Project) => Project) =>
      dispatch({ type: "edit", fn, group: "", at: Date.now() });
    return (
      <Timeline
        key={s.project.id}
        project={s.project}
        selection={selection}
        select={select}
        selected={multi}
        selectMany={selectMany}
        time={time}
        seek={seek}
        edit={edit}
        dispatch={dispatch}
        canUndo={!!s.past.length}
        canRedo={!!s.future.length}
        split={() => {}}
        duplicate={() => {}}
        remove={() => {}}
        hasClipboard={false}
        onClipMenuAction={(action, item) => { lastMenuAction = `${action}:${item.id}`; }}
        draggingTransition={draggingTransition}
        onApplyTransition={(id, name) => {
          lastTransitionTarget = id;
          if (id) edit((p) => setJoinTransition(p, id, name));
        }}
        onOpenTransitions={(id) => { openedTransitionId = id; select({ kind: "clip", id }); }}
        ripple={false}
        setRipple={() => {}}
      />
    );
  }
  const root = createRoot(document.getElementById("root")!);
  const rect = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    width,
    height,
    toJSON() {},
  });
  const geometry = () => {
    const viewport = document.querySelector<HTMLElement>(".timeline-scroll")!;
    viewport.getBoundingClientRect = () => rect(145, 0, 800, 260);
    Object.defineProperty(viewport, "clientWidth", {
      value: 800,
      configurable: true,
    });
    document.querySelector<HTMLElement>(
      ".timeline-content",
    )!.getBoundingClientRect = () =>
      rect(145 - viewport.scrollLeft, 0, 1800, 260);
    let y = 32;
    document.querySelectorAll<HTMLElement>("[data-lane]").forEach((el) => {
      const top = y,
        h = 62;
      el.getBoundingClientRect = () =>
        rect(145 - viewport.scrollLeft, top, 1800, h);
      y += h;
    });
    document.querySelectorAll<HTMLElement>(".timeline-clip").forEach((el) => {
      const lane = el.closest<HTMLElement>("[data-lane]")!;
      el.getBoundingClientRect = () => {
        const parent = lane.getBoundingClientRect();
        return rect(parent.left + parseFloat(el.style.left), parent.top + 6, parseFloat(el.style.width), 50);
      };
    });
  };
  const tick = async () => {
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const cb of callbacks) cb(performance.now());
    });
    geometry();
  };
  const event = async (
    el: Element,
    type: string,
    x: number,
    y: number,
    extra = {},
  ) => {
    await act(async () => {
      el.dispatchEvent(
        new window.MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: y,
          ...extra,
        }),
      );
    });
  };
  const clip = () =>
    document.querySelector<HTMLElement>(
      '[aria-label^="Aurora ridge, starts"]',
    )!;
  const button = (label: string) =>
    document.querySelector<HTMLElement>('[aria-label="' + label + '"]')!;
  try {
    await act(async () => root.render(<Harness />));
    geometry();
    await event(clip(), "dblclick", 200, 170);
    assert.ok(document.querySelector('[role="menu"][aria-label="Clip actions for Aurora ridge"]'));
    assert.ok(![...document.querySelectorAll('[role="menuitem"]')].some((el) => el.textContent?.includes("Freeze frame")), "Demo assets cannot be frozen");
    await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).click());
    assert.equal(lastMenuAction, "copy:clip-aurora");
    assert.equal(document.querySelector('[role="menu"]'), null);
    await event(clip(), "contextmenu", 205, 170, { button: 2 });
    assert.ok(document.querySelector('[role="menu"]'), "Right-click should open the same menu");
    await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
    await event(clip(), "pointerdown", 200, 170);
    await tick();
    await event(clip(), "pointerup", 200, 170);
    assert.ok(selected);
    assert.equal(
      button("Undo").hasAttribute("disabled"),
      true,
      "Selecting a clip must not create an undo item",
    );
    await event(clip(), "pointerdown", 200, 170);
    await event(clip(), "pointermove", 328, 170, { altKey: true });
    await tick();
    await event(clip(), "pointerup", 328, 170);
    assert.equal(
      observed.clips[0].start,
      2,
      "128px at 64px/s should move exactly 2 seconds",
    );
    assert.equal(
      clip().style.left,
      "128px",
      "Visual position must equal actual start time",
    );
    await act(async () => button("Undo").click());
    assert.equal(observed.clips[0].start, 0);
    await act(async () => button("Redo").click());
    assert.equal(observed.clips[0].start, 2);
    await event(clip(), "pointerdown", 328, 170);
    await event(clip(), "pointermove", 328, 100);
    await tick();
    await event(clip(), "pointerup", 328, 100);
    assert.equal(
      observed.clips[0].track,
      2,
      "Video must move into the same layer as text",
    );
    const end = clip().querySelector<HTMLElement>('[aria-label="Trim end"]')!;
    await event(end, "pointerdown", 580, 100);
    await event(end, "pointermove", 516, 100, { altKey: true });
    await tick();
    await event(end, "pointerup", 516, 100);
    assert.ok(
      Math.abs(observed.clips[0].sourceEnd - 3.8) < 0.001,
      "Right trim should remove exactly one second",
    );
    const beforeCancel = observed;
    await event(clip(), "pointerdown", 350, 100);
    await event(clip(), "pointermove", 450, 100, { altKey: true });
    await tick();
    await act(async () =>
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    assert.equal(
      observed,
      beforeCancel,
      "Escape must restore the entire pre-drag project",
    );
    // Scroll offsets are part of the drag delta, but never counted twice.
    const viewport = document.querySelector<HTMLElement>(".timeline-scroll")!;
    viewport.scrollLeft = 200;
    geometry();
    await event(clip(), "pointerdown", 250, 100);
    viewport.scrollLeft = 264;
    await event(clip(), "pointermove", 250, 100, { altKey: true });
    await event(clip(), "pointermove", 314, 100, { altKey: true });
    await tick();
    await event(clip(), "pointerup", 314, 100);
    assert.equal(
      observed.clips[0].start,
      4,
      "Pointer delta plus scroll delta should move exactly two seconds",
    );
    await act(async () => button("Zoom in timeline").click());
    geometry();
    assert.ok(
      Math.abs(parseFloat(clip().style.left) - 4 * 83.2) < 0.01,
      "Zoom must scale real clip positions",
    );
    const start = observed.clips[0].start;
    // Final pointer position is flushed even if pointerup arrives before the next animation frame.
    await event(clip(), "pointerdown", 350, 100);
    await event(clip(), "pointermove", 433.2, 100, { altKey: true });
    await event(clip(), "pointerup", 433.2, 100);
    assert.ok(
      Math.abs(observed.clips[0].start - start - 1) < 0.001,
      "Quick drags should not drop the final move",
    );
    assert.ok(
      captures >= 6,
      "Pointer capture is required to continue dragging outside the clip",
    );
    viewport.scrollLeft = 0;
    geometry();
    const textClip = () =>
      document.querySelector<HTMLElement>(
        '[aria-label^="GO SOMEWHERE NEW, starts"]',
      )!;
    const stableTimeline = document.querySelector<HTMLElement>(".timeline")!;
    const textStart = observed.texts[0].start;
    await event(textClip(), "pointerdown", 250, 100);
    await event(stableTimeline, "pointermove", 250, 170);
    await tick();
    assert.equal(observed.texts[0].track, 1);
    // Continue the SAME drag after React moved the clip to another parent.
    await event(stableTimeline, "pointermove", 250, 230);
    await tick();
    await event(stableTimeline, "pointerup", 250, 230);
    assert.equal(observed.texts[0].track, 0, "Text can move below video");
    assert.equal(
      observed.texts[0].start,
      textStart,
      "Vertical drag must not nudge timing",
    );
    assert.equal(
      textClip().closest<HTMLElement>("[data-lane]")!.dataset.lane,
      "layer:0",
    );
    await act(async () => button("Undo").click());
    assert.equal(
      observed.texts[0].track,
      2,
      "One undo restores the entire cross-layer drag",
    );
    await act(async () => button("Redo").click());
    await act(async () => button("Move to layer below").click());
    geometry();
    assert.equal(
      observed.texts[0].track,
      0,
      "Can send text below the lowest existing layer",
    );
    assert.equal(
      observed.clips[0].track,
      3,
      "Other clips keep their relative stacking",
    );
    await act(async () => button("Move to layer above").click());
    assert.equal(observed.texts[0].track, 1);
    const destination = document.querySelector<HTMLElement>(
      '[data-lane="layer:1"]',
    )!;
    const drop = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(drop, {
      clientX: { value: 400 },
      dataTransfer: { value: { getData: () => "demo-city" } },
    });
    await act(async () => destination.dispatchEvent(drop));
    assert.equal(
      observed.clips.at(-1)!.track,
      1,
      "Media drops onto a text-containing layer",
    );
    assert.ok(document.querySelector('[data-lane="layer:1"] .clip-video'));
    assert.ok(document.querySelector('[data-lane="layer:1"] .clip-text'));

    // Empty timeline space remains editable, regardless of the last clip.
    const ruler = button("Playhead");
    const rulerTime = () => Number(ruler.getAttribute("aria-valuenow"));
    const timelineContent = document.querySelector<HTMLElement>(".timeline-content")!;
    const width = () => parseFloat(timelineContent.style.width);
    const originalDuration = projectDuration(observed);
    viewport.scrollLeft = 60 * 83.2;
    await act(async () => viewport.dispatchEvent(new window.Event("scroll")));
    geometry();
    await event(ruler, "pointerdown", 145 + 5 * 83.2, 16);
    await event(stableTimeline, "pointerup", 145 + 5 * 83.2, 16);
    assert.equal(rulerTime(), 65, "Scrubbing must not stop at the last clip");
    assert.equal(projectDuration(observed), originalDuration, "Navigation must not extend exports");
    await act(async () => ruler.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "ArrowRight", bubbles: true,
    })));
    assert.ok(Math.abs(rulerTime() - (65 + 1 / 30)) < 1e-8);

    const beforeEdge = rulerTime();
    await event(ruler, "pointerdown", 700, 16);
    await event(stableTimeline, "pointermove", 960, 16);
    for (let i = 0; i < 8; i++) await tick();
    await event(stableTimeline, "pointerup", 960, 16);
    assert.ok(rulerTime() > beforeEdge + 4, "Holding a scrub at the edge must auto-scroll");
    assert.ok(viewport.scrollLeft > 60 * 83.2);
    const stoppedAt = rulerTime();
    await tick();
    assert.equal(rulerTime(), stoppedAt, "Release must stop scrubbing");

    const oldWidth = width();
    viewport.scrollLeft = oldWidth - 800;
    await act(async () => viewport.dispatchEvent(new window.Event("scroll")));
    assert.ok(width() > oldWidth, "Scrolling to the edge must reveal more empty space");
    // Long timelines should not create thousands of offscreen ruler elements.
    viewport.scrollLeft = 3600 * 83.2;
    await act(async () => viewport.dispatchEvent(new window.Event("scroll")));
    assert.ok(width() > viewport.scrollLeft + 800);
    assert.ok(ruler.querySelectorAll("span").length < 30);

    // Removing the last clip must not collapse a workspace already explored.
    const retainedWidth = width();
    await act(async () => button("Undo").click());
    assert.ok(width() >= retainedWidth);

    const realVideo = { id: "real", name: "Real video", kind: "video" as const, duration: 8, theme: "video", sizeLabel: "8s" };
    const realProject = newProject();
    realProject.assets = [realVideo];
    realProject.clips = [
      { ...makeClip(realVideo), sourceEnd: 3 },
      { ...makeClip(realVideo, 3), sourceStart: 3, sourceEnd: 6 },
    ];
    await act(async () => load(realProject));
    geometry();
    const lane = document.querySelector<HTMLElement>('[data-lane="layer:0"]')!;
    await event(lane, "pointerdown", 850, 230);
    await event(document.querySelector<HTMLElement>(".timeline")!, "pointermove", 160, 230);
    await event(document.querySelector<HTMLElement>(".timeline")!, "pointerup", 160, 230);
    assert.equal(selectedMany.length, 2, "Marquee selects both clips across its rectangle");
    const firstClip = document.querySelector<HTMLElement>(`[data-clip-id="${realProject.clips[0].id}"]`)!;
    await event(firstClip, "pointerdown", 210, 230);
    await event(firstClip, "pointermove", 274, 230, { altKey: true });
    await tick();
    await event(firstClip, "pointerup", 274, 230);
    assert.equal(observed.clips[0].start, 1, "Group drag moves the first selected clip");
    assert.equal(observed.clips[1].start, 4, "Group drag preserves the second clip offset");
    await act(async () => button("Undo").click());
    assert.equal(observed.clips[0].start, 0, "Group move is one undoable edit");
    const join = document.querySelector<HTMLElement>(".transition-join")!;
    assert.ok(join, "Adjacent clips expose a join drop target");
    assert.ok(join.getAttribute("aria-label")?.includes("Real video and Real video"));
    await act(async () => setDragTransition("Dissolve"));
    const drag = (type: string, target: Element, x = 145 + 3 * 64) => {
      const e = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(e, {
        clientX: { value: x },
        dataTransfer: { value: {
          types: ["application/cutline-transition"],
          getData: (key: string) => key === "application/cutline-transition" ? "Dissolve" : "",
          dropEffect: "none",
        } },
      });
      return e;
    };
    await act(async () => join.dispatchEvent(drag("dragover", join)));
    assert.ok(join.classList.contains("drag-over"));
    await act(async () => join.dispatchEvent(drag("drop", join)));
    assert.equal(lastTransitionTarget, realProject.clips[1].id);
    assert.equal(observed.clips[1].transition, "Dissolve");
    await act(async () => join.click());
    assert.equal(openedTransitionId, realProject.clips[1].id);
    await act(async () => setDragTransition(null));
    await event(document.querySelector(".timeline-clip")!, "dblclick", 200, 170);
    assert.ok([...document.querySelectorAll('[role="menuitem"]')].some((el) => el.textContent?.includes("Freeze frame")), "Imported video offers Freeze frame");
    await act(async () => (document.querySelector('[role="menuitem"]') as HTMLElement).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const audio = { id: "audio", name: "Sound", kind: "audio" as const, duration: 8, theme: "audio", sizeLabel: "8s", waveform: Array.from({ length: 320 }, (_, i) => i < 160 ? 0.1 : 0.8) };
    const audioProject = newProject();
    audioProject.assets = [audio];
    audioProject.clips = [{ ...makeClip(audio), sourceStart: 4, sourceEnd: 8 }];
    await act(async () => load(audioProject));
    const waveform = document.querySelector<SVGElement>(".clip-audio .waveform")!;
    assert.ok(waveform, "Audio clips show their waveform");
    assert.equal(waveform.querySelectorAll("rect").length, 0, "Waveform must not use stretched boxes");
    assert.ok((waveform.querySelector(".waveform-body")?.getAttribute("d") ?? "").includes("M"), "Waveform lines are missing");
    assert.ok(Math.abs(waveformColumns(audio.waveform, undefined, 4, 8, 8, 10)[0].rms - 0.8) < 0.001, "Trimmed waveform starts at the selected source range");
    const protectedProject = newProject();
    protectedProject.assets = [realVideo];
    protectedProject.clips = [{ ...makeClip(realVideo), sourceEnd: 3 }];
    await act(async () => load(protectedProject));
    geometry();
    await act(async () => button("Lock layer:0").click());
    assert.deepEqual(observed.lockedTracks, ["layer:0"]);
    const afterLock = observed;
    const protectedClip = document.querySelector<HTMLElement>(".timeline-clip")!;
    const clipRect = protectedClip.getBoundingClientRect();
    await event(protectedClip, "pointerdown", clipRect.left + 20, clipRect.top + 15);
    await event(document.querySelector(".timeline")!, "pointermove", clipRect.left + 148, clipRect.top + 15);
    await tick();
    await event(document.querySelector(".timeline")!, "pointerup", clipRect.left + 148, clipRect.top + 15);
    assert.equal(observed, afterLock, "Locked clips can be selected but never dragged");
    const protectedTrim = protectedClip.querySelector<HTMLElement>('[aria-label="Trim end"]')!;
    await event(protectedTrim, "pointerdown", clipRect.right, clipRect.top + 15);
    await event(document.querySelector(".timeline")!, "pointerup", clipRect.right - 64, clipRect.top + 15);
    assert.equal(observed, afterLock, "Locked trims must not create a changed project or undo item");
    assert.ok(button("Split at playhead").hasAttribute("disabled"));
    assert.ok(button("Move to layer above").hasAttribute("disabled"));
    await act(async () => button("Unlock layer:0").click());
    const protectedRuler = button("Playhead");
    await event(protectedRuler, "pointerdown", 145 + 4 * 64, 16);
    await event(document.querySelector(".timeline")!, "pointerup", 145 + 4 * 64, 16);
    await act(async () => button("Mark beat").click());
    assert.equal(observed.markers[0].time, 4);
    await event(protectedRuler, "pointerdown", 145, 16);
    await event(document.querySelector(".timeline")!, "pointerup", 145, 16);
    geometry();
    await event(protectedClip, "pointerdown", 170, clipRect.top + 15);
    await event(document.querySelector(".timeline")!, "pointerup", 170 + 3.92 * 64, clipRect.top + 15);
    assert.equal(observed.clips[0].start, 4, "Clip starts magnetically snap to a beat marker");
    const marker = document.querySelector<HTMLElement>(".timeline-marker")!;
    await act(async () => marker.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Delete", bubbles: true })));
    assert.equal(observed.markers.length, 0, "Focused marker Delete removes that timing cue");
    assert.equal(observed.clips.length, 1, "Marker deletion must not delete the selected clip");
    await act(async () => load(newProject()));
    geometry();
    const emptyRuler = button("Playhead");
    await event(emptyRuler, "pointerdown", 145 + 5 * 64, 16);
    await event(document.querySelector(".timeline")!, "pointerup", 145 + 5 * 64, 16);
    assert.equal(Number(emptyRuler.getAttribute("aria-valuenow")), 5);
    assert.equal(projectDuration(observed), 0);
    assert.equal(observed.clips.length + observed.texts.length, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
