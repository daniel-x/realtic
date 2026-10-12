/**
 * Replaces IP addresses in a string with stable placeholders from `table`.
 * @param {string} text
 * @param {Map<string, string>} table
 */
export function redactText(text: string, table: Map<string, string>): string;
/** Formats UTC milliseconds as `yyyy-MM-dd_HH-mm-ss.SSS` (doc §5). */
export function formatTime(ms: any): string;
/** Log levels in ascending order. */
export const LEVELS: string[];
/**
 * Ring buffer logger (section 12.1). Records all levels; `level` filters only the `entry` event
 * and the console mirror. Never throws.
 */
export class Log extends Emitter {
    /** Formats one entry as a line. */
    static line(e: any): string;
    /**
     * @param {object} [options]
     * @param {number} [options.capacity]
     * @param {string} [options.level]
     * @param {boolean} [options.console]
     * @param {boolean} [options.redact]
     * @param {import("../util/clock.js").Clock} [options.clock]
     */
    constructor({ capacity, level, console: mirror, redact, clock }?: {
        capacity?: number;
        level?: string;
        console?: boolean;
        redact?: boolean;
        clock?: import("../util/clock.js").Clock;
    });
    level: string;
    mirror: boolean;
    redact: boolean;
    /** Buffer capacity. */
    get capacity(): number;
    /**
     * Writes one entry.
     * @param {"debug"|"info"|"warn"|"error"} level
     * @param {string} area
     * @param {string} msg
     * @param {object} [data]
     * @param {{peer?: string, session?: string}} [ids]
     */
    write(level: "debug" | "info" | "warn" | "error", area: string, msg: string, data?: object, ids?: {
        peer?: string;
        session?: string;
    }): void;
    /**
     * Returns a scoped writer with fixed area and ids.
     * @param {string} area
     * @param {{peer?: string, session?: string}} [ids]
     */
    scope(area: string, ids?: {
        peer?: string;
        session?: string;
    }): {
        debug: (msg: any, data: any) => void;
        info: (msg: any, data: any) => void;
        warn: (msg: any, data: any) => void;
        error: (msg: any, data: any) => void;
        ids: {
            peer?: string;
            session?: string;
        };
    };
    /**
     * Copy of buffered entries, oldest first.
     * @param {{since?: number, level?: string}} [filter]
     */
    entries({ since, level }?: {
        since?: number;
        level?: string;
    }): any[];
    /** The buffered entries as readable lines. Timestamps are UTC. */
    text(filter: any): string;
    /** Empties the buffer; `seq` keeps counting. */
    clear(): void;
    /** Redacts a string with this log's placeholder table. */
    redactString(text: any): string;
    #private;
}
import { Emitter } from "../util/emitter.js";
