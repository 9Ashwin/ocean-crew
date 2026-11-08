// Whether two on-screen rectangles overlap: used to decide if a floating layer covers
// the part of the interface it describes.

export interface Rect {
	left: number;
	top: number;
	width: number;
	height: number;
	right: number;
	bottom: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
	return (
		a.width > 0 &&
		a.height > 0 &&
		b.width > 0 &&
		b.height > 0 &&
		a.left < b.right &&
		a.right > b.left &&
		a.top < b.bottom &&
		a.bottom > b.top
	);
}
