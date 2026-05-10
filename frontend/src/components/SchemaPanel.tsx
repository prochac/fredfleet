import {useState} from 'react';
import {catalog} from '../../wailsjs/go/models';

type Props = {schema: catalog.SchemaDTO};

export function SchemaPanel({schema}: Props) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const identifierIDs = new Set(schema.identifierFieldIds ?? []);

    const toggle = (path: string) => {
        setExpanded((s) => {
            const next = new Set(s);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    if (!schema.fields || schema.fields.length === 0) {
        return <p className="empty">Schema has no fields.</p>;
    }
    return (
        <div className="schema-tree" role="tree">
            {schema.fields.map((f, i) => (
                <FieldRow
                    key={f.id + ':' + f.name + ':' + i}
                    field={f}
                    depth={0}
                    path={f.name}
                    expanded={expanded}
                    onToggle={toggle}
                    identifierIDs={identifierIDs}
                />
            ))}
        </div>
    );
}

function FieldRow({
    field,
    depth,
    path,
    expanded,
    onToggle,
    identifierIDs,
}: {
    field: catalog.FieldDTO;
    depth: number;
    path: string;
    expanded: Set<string>;
    onToggle: (path: string) => void;
    identifierIDs: Set<number>;
}) {
    const hasChildren = field.kind !== 'primitive' && (field.children?.length ?? 0) > 0;
    const isOpen = hasChildren && expanded.has(path);
    return (
        <div className="field-row-wrap">
            <div
                className="field-row"
                style={{paddingLeft: 8 + depth * 16}}
                onClick={() => hasChildren && onToggle(path)}
                role="treeitem"
                aria-expanded={hasChildren ? isOpen : undefined}
            >
                <span className="field-toggle" aria-hidden>
                    {hasChildren ? (isOpen ? '▾' : '▸') : ''}
                </span>
                <span className="field-id">#{field.id}</span>
                <span className="field-name">{field.name}</span>
                <span className="field-sep">:</span>
                <span className="field-type mono">{field.typeText || field.kind}</span>
                <span className={'field-required ' + (field.required ? 'required' : 'optional')}>
                    {field.required ? 'required' : 'optional'}
                </span>
                {identifierIDs.has(field.id) && <span className="field-tag">identifier</span>}
                {field.doc && <span className="field-doc">— {field.doc}</span>}
            </div>
            {isOpen &&
                field.children?.map((c, i) => (
                    <FieldRow
                        key={c.id + ':' + c.name + ':' + i}
                        field={c}
                        depth={depth + 1}
                        path={path + '/' + c.name + ':' + i}
                        expanded={expanded}
                        onToggle={onToggle}
                        identifierIDs={identifierIDs}
                    />
                ))}
        </div>
    );
}
