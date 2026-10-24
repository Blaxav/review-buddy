// 16px stroke icons, drawn for the overlay. `sparkle` is the Claude mark.
const PATHS = {
  sparkle: { fill: "M8 .75c.45 3.7 3.55 6.8 7.25 7.25C11.55 8.45 8.45 11.55 8 15.25 7.55 11.55 4.45 8.45.75 8 4.45 7.55 7.55 4.45 8 .75Z" },
  close: { stroke: "M4 4l8 8M12 4l-8 8" },
  newChat: { stroke: "M7.5 2.5H4A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V8.5M11.75 1.75l2.5 2.5L8.5 10H6V7.5l5.75-5.75Z" },
  send: { stroke: "M8 13V3.5M3.75 7.5 8 3.25l4.25 4.25" },
  stop: { fill: "M5 4h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" },
  chevron: { stroke: "M6 3.75 10.25 8 6 12.25" },
  file: { stroke: "M9 1.75H4.5a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-8M9 1.75v3.5h3.5M9 1.75l3.5 3.5" },
  check: { stroke: "M3 8.5 6.25 11.75 13 5" },
  insert: { stroke: "M8 2v8M4.75 6.75 8 10l3.25-3.25M3 13.5h10" },
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
