/**
 * A minimal OTLP/protobuf encoder for ops' own gauges and sums
 * (`ExportMetricsServiceRequest`, opentelemetry-proto v1 metrics). The ops
 * module may not import granary's encoder (`src/lib/server/otlp-encode.ts`,
 * ADR 0080), and @tinyactors/node encodes only its host's own counters
 * (`host.metrics()`), so this writes the few message types ops needs:
 *
 *   ExportMetricsServiceRequest { 1 ResourceMetrics }
 *   ResourceMetrics { 1 Resource { 1 KeyValue* }, 2 ScopeMetrics }
 *   ScopeMetrics { 1 InstrumentationScope { 1 name, 2 version }, 2 Metric* }
 *   Metric { 1 name, 3 unit, 5 Gauge | 7 Sum }
 *   Gauge { 1 NumberDataPoint* }   Sum { 1 NumberDataPoint*, 2 temporality, 3 is_monotonic }
 *   NumberDataPoint { 7 KeyValue*, 2 start_time_unix_nano, 3 time_unix_nano, 4 as_double }
 *   KeyValue { 1 key, 2 AnyValue { 1 string_value } }
 */

export interface MetricPoint {
	attributes: Record<string, string>;
	value: number;
}

export interface MetricData {
	name: string;
	unit: string;
	kind: 'gauge' | 'sum';
	points: MetricPoint[];
}

const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_VARINT = 0;
/** AggregationTemporality CUMULATIVE. */
const CUMULATIVE = 2;

class Writer {
	#out: number[] = [];

	bytes(): Uint8Array {
		return Uint8Array.from(this.#out);
	}

	varint(value: number | bigint): void {
		let v = BigInt.asUintN(64, BigInt(value));
		while (v >= 0x80n) {
			this.#out.push(Number(v & 0x7fn) | 0x80);
			v >>= 7n;
		}
		this.#out.push(Number(v));
	}

	tag(field: number, wire: number): void {
		this.varint((field << 3) | wire);
	}

	bytesField(field: number, bytes: Uint8Array): void {
		this.tag(field, WIRE_LEN);
		this.varint(bytes.length);
		for (const b of bytes) this.#out.push(b);
	}

	string(field: number, text: string): void {
		this.bytesField(field, new TextEncoder().encode(text));
	}

	message(field: number, build: (w: Writer) => void): void {
		const inner = new Writer();
		build(inner);
		this.bytesField(field, inner.bytes());
	}

	uint(field: number, value: number): void {
		this.tag(field, WIRE_VARINT);
		this.varint(value);
	}

	fixed64(field: number, value: bigint): void {
		this.tag(field, WIRE_FIXED64);
		const view = new DataView(new ArrayBuffer(8));
		view.setBigUint64(0, BigInt.asUintN(64, value), true);
		for (const b of new Uint8Array(view.buffer)) this.#out.push(b);
	}

	double(field: number, value: number): void {
		this.tag(field, WIRE_FIXED64);
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, value, true);
		for (const b of new Uint8Array(view.buffer)) this.#out.push(b);
	}

	keyValue(field: number, key: string, value: string): void {
		this.message(field, (kv) => {
			kv.string(1, key);
			kv.message(2, (any) => any.string(1, value));
		});
	}
}

const nanos = (ms: number) => BigInt(Math.round(ms)) * 1_000_000n;

/** One ExportMetricsServiceRequest of `metrics`, every point at `time` (ms), cumulative from `startTime` (ms). */
export function encodeMetrics(input: {
	metrics: MetricData[];
	startTime: number;
	time: number;
	resource: Record<string, string>;
	scope: { name: string; version: string };
}): Uint8Array {
	const w = new Writer();
	w.message(1, (rm) => {
		rm.message(1, (res) => {
			for (const [k, v] of Object.entries(input.resource)) res.keyValue(1, k, v);
		});
		rm.message(2, (sm) => {
			sm.message(1, (scope) => {
				scope.string(1, input.scope.name);
				scope.string(2, input.scope.version);
			});
			for (const m of input.metrics) {
				sm.message(2, (metric) => {
					metric.string(1, m.name);
					if (m.unit) metric.string(3, m.unit);
					metric.message(m.kind === 'gauge' ? 5 : 7, (data) => {
						for (const p of m.points)
							data.message(1, (dp) => {
								for (const [k, v] of Object.entries(p.attributes)) dp.keyValue(7, k, v);
								dp.fixed64(2, nanos(input.startTime));
								dp.fixed64(3, nanos(input.time));
								dp.double(4, p.value);
							});
						if (m.kind === 'sum') {
							data.uint(2, CUMULATIVE);
							data.uint(3, 1);
						}
					});
				});
			}
		});
	});
	return w.bytes();
}
