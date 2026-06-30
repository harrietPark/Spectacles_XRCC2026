export class CustomMath {
    public static multiplyScale(baseScale: vec3, multiplier: number): vec3 {
        return new vec3(
            baseScale.x * multiplier,
            baseScale.y * multiplier,
            baseScale.z * multiplier,
        );
    }

    public static lerp(start: number, end: number, t: number): number {
        return start + (end - start) * t;
    }

    public static easeInOutCubic(t: number): number {
        if (t < 0.5) {
            return 4 * t * t * t;
        }
        const p = -2 * t + 2;
        return 1 - (p * p * p) / 2;
    }
}