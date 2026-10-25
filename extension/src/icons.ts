// 16px stroke icons, drawn for the overlay. `sparkle` is the Claude mark.
const PATHS = {
  sparkle: { fill: "M8 .75c.45 3.7 3.55 6.8 7.25 7.25C11.55 8.45 8.45 11.55 8 15.25 7.55 11.55 4.45 8.45.75 8 4.45 7.55 7.55 4.45 8 .75Z" },
  close: { stroke: "M4 4l8 8M12 4l-8 8" },
  newChat: { stroke: "M7.5 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V8.5M11.75 1.75l2.5 2.5L8.5 10H6V7.5l5.75-5.75Z" },
  send: { stroke: "M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" },
  stop: { fill: "M5 4h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" },
  chevron: { stroke: "M6 3.75 10.25 8 6 12.25" },
  back: { stroke: "M10 3.75 5.75 8 10 12.25" },
  list: { stroke: "M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01" },
  file: { stroke: "M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-8M9 1.75v3.5h3.5M9 1.75l3.5 3.5" },
  check: { stroke: "M3 8.5 6.25 11.75 13 5" },
  insert: { stroke: "M8 2v8M4.75 6.75 8 10l3.25-3.25M3 13.5h10" },
  blocks: { stroke: "M2.75 2.75h4v4h-4zM9.25 2.75h4v4h-4zM2.75 9.25h4v4h-4zM9.25 9.25h4v4h-4z" },
  refresh: { stroke: "M13.25 8A5.25 5.25 0 1 1 11.7 4.3M13.25 2.5v3h-3" },
  warning: { stroke: "M8 2 14.5 13.5h-13L8 2ZM8 6.5v3M8 11.5v.01" },
  minimize: { stroke: "M4 8h8" },
  comment: { stroke: "M2.75 3.25a1 1 0 0 1 1-1h8.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3 2.5v-2.5h-.25a1 1 0 0 1-1-1v-6.5Z" },
} as const;

export type IconName = keyof typeof PATHS;

const SVG = "http://www.w3.org/2000/svg";

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon icon-${name}`);
  const spec: { fill?: string; stroke?: string } = PATHS[name];
  const path = document.createElementNS(SVG, "path");
  if (spec.fill) {
    path.setAttribute("d", spec.fill);
    path.setAttribute("fill", "currentColor");
  } else {
    path.setAttribute("d", spec.stroke!);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  }
  svg.append(path);
  return svg;
}
