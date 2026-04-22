// a computationally light low-pass filter that uses exponential moving average
export class ExponentialMovingAverage {
    private alpha: number; // bigger alpha = heavier smoothing, slower response
    private prevRes: vec3;

    constructor(alpha: number) {
        this.alpha = alpha;
        this.prevRes = vec3.zero();
    }

    public process(inSample: vec3, isFirstSample: boolean = false): vec3 {
        if (isFirstSample) {
            this.prevRes = inSample;
            return inSample;
        }
        
        // y[n] = (1 - alpha) * x[n] + alpha * y[n-1]
        let res = new vec3(
            inSample.x * (1.0 - this.alpha) + this.alpha * this.prevRes.x,
            inSample.y * (1.0 - this.alpha) + this.alpha * this.prevRes.y,
            inSample.z * (1.0 - this.alpha) + this.alpha * this.prevRes.z
        );
        this.prevRes = res;

        return res;
    }
}