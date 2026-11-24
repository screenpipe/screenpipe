// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Triangle resize in source pixel space, matching image::FilterType::Triangle.
// Never read a masked texel, including texels in the resize filter's footprint.
bool is_masked(uint2 p, MASK_INPUTS) {
    for (uint i = 0; i < plan[1].x; ++i) {
        uint4 r = plan[i + 2];
        if (p.x >= r.x && p.x < r.z && p.y >= r.y && p.y < r.w) return true;
    }
    return false;
}

float4 pixel(uint2 p, INPUTS) {
    uint4 dims = plan[0];
    uint4 flags = plan[1];
    if (flags.y != 0) return float4(0, 0, 0, 1);

    if (all(dims.xy == dims.zw)) {
        if (is_masked(p, MASK_ARG)) return float4(0, 0, 0, 1);
        float4 color = SOURCE_TEXEL(p.x, p.y);
        if (flags.z != 0 && color.a == 0) return float4(0, 0, 0, 1);
        return float4(color.rgb, 1);
    }

    float2 ratio = float2(dims.xy) / float2(dims.zw);
    float2 radius = max(ratio, float2(1, 1));
    float2 center = (float2(p) + float2(0.5, 0.5)) * ratio;
    uint2 begin = uint2(max(floor(center - radius), float2(0, 0)));
    uint2 end = uint2(min(ceil(center + radius), float2(dims.xy)));
    float3 sum = float3(0, 0, 0);
    float normalizer = 0;
    for (uint y = begin.y; y < end.y; ++y) {
        for (uint x = begin.x; x < end.x; ++x) {
            float2 w = max(float2(0, 0), float2(1, 1) -
                abs((float2(x, y) + float2(0.5, 0.5) - center) / radius));
            float weight = w.x * w.y;
            if (weight == 0) continue;
            normalizer += weight;
            if (!is_masked(uint2(x, y), MASK_ARG)) {
                float4 color = SOURCE_TEXEL(x, y);
                if (flags.z == 0 || color.a > 0) sum += color.rgb * weight;
            }
        }
    }
    return float4(sum / normalizer, 1);
}
