import {describe, expect, it, beforeEach} from 'vitest';
import {
    clearRememberedFilters,
    flattenFilterableColumns,
    forgetConnectionFilters,
    isEffective,
    opsForColumn,
    parseSetValues,
    pruneFilters,
    recallFilters,
    rememberFilters,
    tableKey,
    toFilterList,
    type FilterColumn,
    type FilterEntry,
} from './filters';

function entry(over: Partial<FilterEntry> = {}): FilterEntry {
    return {id: 'x', field: 'id', op: 'eq', value: '1', join: 'and', ...over};
}

// The schema DTO shape, only as much of it as the flattener reads.
const schema = {
    fields: [
        {name: 'id', kind: 'primitive', typeText: 'long', children: []},
        {name: 'blob', kind: 'primitive', typeText: 'binary', children: []},
        {
            name: 'addr',
            kind: 'struct',
            typeText: 'struct<...>',
            children: [
                {name: 'city', kind: 'primitive', typeText: 'string', children: []},
                {
                    name: 'geo',
                    kind: 'struct',
                    typeText: 'struct<...>',
                    children: [{name: 'lat', kind: 'primitive', typeText: 'double', children: []}],
                },
            ],
        },
        {
            name: 'tags',
            kind: 'list',
            typeText: 'list<string>',
            children: [{name: 'element', kind: 'primitive', typeText: 'string', children: []}],
        },
        {
            name: 'props',
            kind: 'map',
            typeText: 'map<string, string>',
            children: [
                {name: 'key', kind: 'primitive', typeText: 'string', children: []},
                {name: 'value', kind: 'primitive', typeText: 'string', children: []},
            ],
        },
    ],
} as never;

describe('flattenFilterableColumns', () => {
    it('exposes nested struct fields under their dotted path', () => {
        const cols = flattenFilterableColumns(schema).map((c) => c.name);
        expect(cols).toContain('addr.city');
        expect(cols).toContain('addr.geo.lat');
    });

    it('does not descend into lists or maps', () => {
        // A predicate cannot reference a field through a collection, and the
        // synthetic element/key/value children would be nonsense as targets.
        const cols = flattenFilterableColumns(schema).map((c) => c.name);
        expect(cols).not.toContain('tags.element');
        expect(cols).not.toContain('props.key');
        expect(cols).not.toContain('props.value');
    });

    it('omits binary columns, which have no usable comparison', () => {
        expect(flattenFilterableColumns(schema).map((c) => c.name)).not.toContain('blob');
    });

    it('marks nested columns so the UI can distinguish them', () => {
        const cols = flattenFilterableColumns(schema);
        expect(cols.find((c) => c.name === 'id')!.nested).toBe(false);
        expect(cols.find((c) => c.name === 'addr.city')!.nested).toBe(true);
    });

    it('survives a missing schema', () => {
        expect(flattenFilterableColumns(undefined)).toEqual([]);
    });
});

describe('opsForColumn', () => {
    it('offers only equality and null checks on booleans', () => {
        const ops = opsForColumn({name: 'b', typeText: 'boolean', nested: false});
        expect(ops).toEqual(['eq', 'neq', 'in', 'notin', 'isnull', 'notnull']);
    });

    it('offers nothing for binary', () => {
        expect(opsForColumn({name: 'b', typeText: 'binary', nested: false})).toEqual([]);
    });

    it('never offers `starts`, which the backend rejects on every type', () => {
        const ops = opsForColumn({name: 's', typeText: 'string', nested: false});
        expect(ops).not.toContain('starts');
    });
});

describe('parseSetValues', () => {
    it('splits on commas and newlines and trims', () => {
        expect(parseSetValues(' a, b \n c ')).toEqual(['a', 'b', 'c']);
    });

    it('drops empties so a trailing comma mid-typing is not a broken filter', () => {
        expect(parseSetValues('a, b,')).toEqual(['a', 'b']);
        expect(parseSetValues('  ')).toEqual([]);
    });
});

describe('isEffective', () => {
    it('needs no value for null operators', () => {
        expect(isEffective(entry({op: 'isnull', value: ''}))).toBe(true);
    });

    it('needs at least one parsed value for set operators', () => {
        expect(isEffective(entry({op: 'in', value: ' , '}))).toBe(false);
        expect(isEffective(entry({op: 'in', value: 'a,'}))).toBe(true);
    });

    it('ignores a row with no column or operator picked yet', () => {
        expect(isEffective(entry({field: ''}))).toBe(false);
        expect(isEffective(entry({op: ''}))).toBe(false);
    });
});

describe('toFilterList', () => {
    it('drops the join on the first sent row', () => {
        const out = toFilterList([entry({id: '1', join: 'or'})]);
        expect(out[0]).not.toHaveProperty('join');
    });

    it('sends values as a list for set operators', () => {
        const out = toFilterList([entry({op: 'in', value: 'a, b'})]);
        expect(out[0]).toMatchObject({op: 'in', values: ['a', 'b']});
        expect(out[0]).not.toHaveProperty('value');
    });

    it('sends no operand at all for null operators', () => {
        const out = toFilterList([entry({op: 'notnull', value: 'ignored'})]);
        expect(out[0]).not.toHaveProperty('value');
        expect(out[0]).not.toHaveProperty('values');
    });

    it('joins relative to the previous *sent* row, not the previous row', () => {
        // The middle row is incomplete and is not sent. If `join` were taken
        // positionally, the third row's "or" would be dropped as if it were
        // first, silently turning a union into an intersection.
        const out = toFilterList([
            entry({id: '1', field: 'id', op: 'eq', value: '1'}),
            entry({id: '2', field: '', op: '', value: ''}),
            entry({id: '3', field: 'id', op: 'eq', value: '2', join: 'or'}),
        ]);
        expect(out).toHaveLength(2);
        expect(out[1]).toMatchObject({join: 'or'});
    });
});

describe('pruneFilters', () => {
    const columns: FilterColumn[] = [
        {name: 'id', typeText: 'long', nested: false},
        {name: 'flag', typeText: 'boolean', nested: false},
    ];

    it('drops filters on columns the new table does not have', () => {
        const {kept, dropped} = pruneFilters(
            [entry({id: '1', field: 'id'}), entry({id: '2', field: 'gone'})],
            columns,
        );
        expect(kept.map((f) => f.id)).toEqual(['1']);
        expect(dropped).toBe(1);
    });

    it('drops operators the new column type cannot answer', () => {
        // `lt` is meaningless on a boolean and the backend rejects it.
        const {kept} = pruneFilters([entry({field: 'flag', op: 'lt'})], columns);
        expect(kept).toEqual([]);
    });

    it('keeps half-filled rows the user is still editing', () => {
        const {kept} = pruneFilters([entry({field: '', op: ''})], columns);
        expect(kept).toHaveLength(1);
    });

    it('rewrites a surviving first row so it does not lead with "or"', () => {
        const {kept} = pruneFilters(
            [entry({id: '1', field: 'gone'}), entry({id: '2', field: 'id', join: 'or'})],
            columns,
        );
        expect(kept[0].join).toBe('and');
    });
});

describe('remembered filters', () => {
    beforeEach(clearRememberedFilters);

    it('recalls what was stored for a table', () => {
        const key = tableKey('conn', ['ns'], 'tbl');
        rememberFilters(key, [entry()]);
        expect(recallFilters(key)).toHaveLength(1);
    });

    it('keeps tables apart, including namespaces that would collide when joined', () => {
        const a = tableKey('conn', ['a', 'b'], 'tbl');
        const b = tableKey('conn', ['a'], 'b.tbl');
        expect(a).not.toBe(b);
    });

    it('forgets a table whose filters were all cleared', () => {
        const key = tableKey('conn', ['ns'], 'tbl');
        rememberFilters(key, [entry()]);
        rememberFilters(key, []);
        expect(recallFilters(key)).toEqual([]);
    });

    it('does not remember rows that are entirely blank', () => {
        const key = tableKey('conn', ['ns'], 'tbl');
        rememberFilters(key, [entry({field: '', op: '', value: ''})]);
        expect(recallFilters(key)).toEqual([]);
    });

    it('forgets every table on a connection at once', () => {
        const a = tableKey('conn', ['ns'], 'one');
        const b = tableKey('conn', ['ns'], 'two');
        const other = tableKey('other', ['ns'], 'one');
        rememberFilters(a, [entry()]);
        rememberFilters(b, [entry()]);
        rememberFilters(other, [entry()]);

        forgetConnectionFilters('conn');

        expect(recallFilters(a)).toEqual([]);
        expect(recallFilters(b)).toEqual([]);
        expect(recallFilters(other)).toHaveLength(1);
    });
});
