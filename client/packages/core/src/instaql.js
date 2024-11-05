import { query as datalogQuery } from "./datalog";
import { uuidCompare } from "./utils/uuid";
import * as s from "./store";

// Pattern variables
// -----------------

let _seed = 0;

function wildcard(friendlyName) {
  return makeVarImpl(`_${friendlyName}`, _seed++);
}

function makeVarImpl(x, level) {
  return `?${x}-${level}`;
}

// Where
// -----------------

class AttrNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "AttrNotFoundError";
  }
}

function idAttr(store, ns) {
  const attr = s.getPrimaryKeyAttr(store, ns);

  if (!attr) {
    throw new AttrNotFoundError(`Could not find id attr for ${ns}`);
  }
  return attr;
}

function defaultWhere(makeVar, store, etype, level) {
  return [eidWhere(makeVar, store, etype, level)];
}

function eidWhere(makeVar, store, etype, level) {
  return [
    makeVar(etype, level),
    idAttr(store, etype).id,
    makeVar(etype, level),
    makeVar("time", level),
  ];
}

function replaceInAttrPat(attrPat, needle, v) {
  return attrPat.map((x) => (x === needle ? v : x));
}

function refAttrPat(makeVar, store, etype, level, label) {
  const fwdAttr = s.getAttrByFwdIdentName(store, etype, label);
  const revAttr = s.getAttrByReverseIdentName(store, etype, label);
  const attr = fwdAttr || revAttr;

  if (!attr) {
    throw new AttrNotFoundError(`Could not find attr for ${[etype, label]}`);
  }

  if (attr["value-type"] !== "ref") {
    throw new Error(`Attr ${attr.id} is not a ref`);
  }

  const [_f, fwdEtype] = attr["forward-identity"];
  const [_r, revEtype] = attr["reverse-identity"];
  const nextLevel = level + 1;
  const attrPat = fwdAttr
    ? [
        makeVar(fwdEtype, level),
        attr.id,
        makeVar(revEtype, nextLevel),
        wildcard("time"),
      ]
    : [
        makeVar(fwdEtype, nextLevel),
        attr.id,
        makeVar(revEtype, level),
        wildcard("time"),
      ];

  const nextEtype = fwdAttr ? revEtype : fwdEtype;

  const isForward = Boolean(fwdAttr);

  return [nextEtype, nextLevel, attrPat, attr, isForward];
}

function valueAttrPat(makeVar, store, valueEtype, valueLevel, valueLabel, v) {
  const attr = s.getAttrByFwdIdentName(store, valueEtype, valueLabel);

  if (!attr) {
    throw new AttrNotFoundError(
      `No attr for etype = ${valueEtype} label = ${valueLabel} value-label`,
    );
  }

  if (v?.hasOwnProperty("$isNull")) {
    const idAttr = s.getAttrByFwdIdentName(store, valueEtype, "id");
    if (!idAttr) {
      throw new AttrNotFoundError(
        `No attr for etype = ${valueEtype} label = id value-label`,
      );
    }
    return [
      makeVar(valueEtype, valueLevel),
      idAttr.id,
      { $isNull: { attrId: attr.id, isNull: v.$isNull } },
      wildcard("time"),
    ];
  }

  return [makeVar(valueEtype, valueLevel), attr.id, v, wildcard("time")];
}

function refAttrPats(makeVar, store, etype, level, refsPath) {
  const [lastEtype, lastLevel, attrPats] = refsPath.reduce(
    (acc, label) => {
      const [etype, level, attrPats] = acc;
      const [nextEtype, nextLevel, attrPat] = refAttrPat(
        makeVar,
        store,
        etype,
        level,
        label,
      );
      return [nextEtype, nextLevel, [...attrPats, attrPat]];
    },
    [etype, level, []],
  );

  return [lastEtype, lastLevel, attrPats];
}

function whereCondAttrPats(makeVar, store, etype, level, path, v) {
  const refsPath = path.slice(0, path.length - 1);
  const valueLabel = path[path.length - 1];
  const [lastEtype, lastLevel, refPats] = refAttrPats(
    makeVar,
    store,
    etype,
    level,
    refsPath,
  );
  const valuePat = valueAttrPat(
    makeVar,
    store,
    lastEtype,
    lastLevel,
    valueLabel,
    v,
  );

  return refPats.concat([valuePat]);
}

function withJoin(where, join) {
  return join ? [join].concat(where) : where;
}

function isOrClauses([k, v]) {
  return k === "or" && Array.isArray(v);
}

function isAndClauses([k, v]) {
  return k === "and" && Array.isArray(v);
}

// Creates a makeVar that will namespace symbols for or clauses
// to prevent conflicts, except for the base etype
function genMakeVar(baseMakeVar, etype, orIdx) {
  return (x, lvl) => {
    if (x == etype) {
      return baseMakeVar(x, lvl);
    }
    return `${baseMakeVar(x, lvl)}-${orIdx}`;
  };
}

function parseWhereClauses(
  makeVar,
  clauseType /* 'or' | 'and' */,
  store,
  etype,
  level,
  whereValue,
) {
  const patterns = whereValue.map((w, i) => {
    const makeNamespacedVar = genMakeVar(makeVar, etype, i);
    return parseWhere(makeNamespacedVar, store, etype, level, w);
  });
  const joinSym = makeVar(etype, level);
  return { [clauseType]: { patterns, joinSym } };
}

// Given a path, returns a list of paths leading up to this path:
// growPath([1, 2, 3]) -> [[1], [1, 2], [1, 2, 3]]
function growPath(path) {
  const ret = [];
  for (let i = 1; i <= path.length; i++) {
    ret.push(path.slice(0, i));
  }
  return ret;
}

// Returns array of pattern arrays that should be grouped in OR
// to capture any intermediate nulls
function whereCondAttrPatsForNullIsTrue(makeVar, store, etype, level, path) {
  return growPath(path).map((path) =>
    whereCondAttrPats(makeVar, store, etype, level, path, { $isNull: true }),
  );
}

function parseWhere(makeVar, store, etype, level, where) {
  return Object.entries(where).flatMap(([k, v]) => {
    if (isOrClauses([k, v])) {
      return parseWhereClauses(makeVar, "or", store, etype, level, v);
    }
    if (isAndClauses([k, v])) {
      return parseWhereClauses(makeVar, "and", store, etype, level, v);
    }

    const path = k.split(".");

    if (v?.hasOwnProperty("$not")) {
      // `$not` won't pick up entities that are missing the attr, so we
      // add in a `$isNull` to catch those too.
      const notPats = whereCondAttrPats(makeVar, store, etype, level, path, v);
      const nilPats = whereCondAttrPatsForNullIsTrue(
        makeVar,
        store,
        etype,
        level,
        path,
      );
      return [
        {
          or: {
            patterns: [notPats, ...nilPats],
            joinSym: makeVar(etype, level),
          },
        },
      ];
    }

    if (v?.hasOwnProperty("$isNull") && v.$isNull === true && path.length > 1) {
      // Make sure we're capturing all of the intermediate paths that might be null
      // by checking for null at each step along the path
      return [
        {
          or: {
            patterns: whereCondAttrPatsForNullIsTrue(
              makeVar,
              store,
              etype,
              level,
              path,
            ),
            joinSym: makeVar(etype, level),
          },
        },
      ];
    }

    return whereCondAttrPats(makeVar, store, etype, level, path, v);
  });
}

function makeWhere(store, etype, level, where) {
  const makeVar = makeVarImpl;
  if (!where) {
    return defaultWhere(makeVar, store, etype, level);
  }
  const parsedWhere = parseWhere(makeVar, store, etype, level, where);
  return parsedWhere.concat(defaultWhere(makeVar, store, etype, level));
}

// Find
// -----------------

function makeFind(makeVar, etype, level) {
  return [makeVar(etype, level), makeVar("time", level)];
}

// extendObjects
// -----------------

function makeJoin(makeVar, store, etype, level, label, eid) {
  const [nextEtype, nextLevel, pat, attr, isForward] = refAttrPat(
    makeVar,
    store,
    etype,
    level,
    label,
  );
  const actualized = replaceInAttrPat(pat, makeVar(etype, level), eid);
  return [nextEtype, nextLevel, actualized, attr, isForward];
}

function extendObjects(makeVar, store, { etype, level, form }, objects) {
  const childQueries = Object.keys(form).filter((c) => c !== "$");
  if (!childQueries.length) {
    return Object.values(objects);
  }
  return Object.entries(objects).map(function extendChildren([eid, parent]) {
    const childResults = childQueries.map(function getChildResult(label) {
      const isSingular = Boolean(
        store.cardinalityInference &&
          store.linkIndex?.[etype]?.[label]?.isSingular,
      );

      try {
        const [nextEtype, nextLevel, join] = makeJoin(
          makeVar,
          store,
          etype,
          level,
          label,
          eid,
        );

        const childrenArray = queryOne(store, {
          etype: nextEtype,
          level: nextLevel,
          form: form[label],
          join,
        });

        const childOrChildren = isSingular ? childrenArray[0] : childrenArray;

        return { [label]: childOrChildren };
      } catch (e) {
        if (e instanceof AttrNotFoundError) {
          return { [label]: isSingular ? undefined : [] };
        }
        throw e;
      }
    });

    return childResults.reduce(function reduceChildren(parent, child) {
      Object.assign(parent, child);
      return parent;
    }, parent);
    return parent;
  });
}

// resolveObjects
// -----------------

function shouldIgnoreAttr(attrs, id) {
  const attr = attrs[id];
  return attr["value-type"] === "ref" && attr["forward-identity"][2] !== "id";
}

function cursorCompare(direction, typ) {
  switch (direction) {
    case "asc":
      switch (typ) {
        case "number":
          return (x, y) => x < y;
        case "uuid":
          return (x, y) => uuidCompare(x, y) === -1;
      }
    case "desc":
      switch (typ) {
        case "number":
          return (x, y) => x > y;
        case "uuid":
          return (x, y) => uuidCompare(x, y) === 1;
      }
  }
}

function isBefore(startCursor, direction, [e, _a, _v, t]) {
  return (
    cursorCompare(direction, "number")(t, startCursor[3]) ||
    (t === startCursor[3] &&
      cursorCompare(direction, "uuid")(e, startCursor[0]))
  );
}

function isFind([a, b], [c, d]) {
  return a === c && b === d;
}

function transformIdVecs(store, etype, idVecs) {
  let objects = {};
  for (const [id, time] of idVecs) {
    const obj = s.getAsObject(store, etype, id);
    if (obj) {
      objects[id] = obj;
    }
  }
  return objects;
}

function customQueryForAsset(store, etype, join) {
  const projectId = join[0];
  const refAttrId = join[1];
  const assetRefTriples = store.eav.get(projectId)?.get(refAttrId)?.values();
  const assetIds = new Set(assetRefTriples?.map((t) => t[2]));
  const trashedAttrId = "d52ad3bf-22b9-4a27-902a-16bd6e7d1109";

  let resultingIds = new Set();
  assetIds.forEach((assetId) => {
    if (store.eav.get(assetId)?.get(trashedAttrId)?.get(true)) {
      return;
    }
    resultingIds.add(assetId);
  });
  let idAttrId = "7fd6add9-9bfc-4d20-b582-28458f6616c5";
  let idVecs = [];
  resultingIds.forEach((id) => {
    let time = store.eav.get(id)?.get(idAttrId)?.get(id)?.[3];
    idVecs.push([id, time]);
  });
  return transformIdVecs(store, etype, idVecs);
}

function customQueryForTask(store, etype, join) {
  const assetId = join[0];
  const refAttrId = join[1];
  const taskRefTriples = store.eav.get(assetId)?.get(refAttrId)?.values();
  const taskIds = new Set(taskRefTriples?.map((t) => t[2]));
  const trashedAttrId = "66769434-3d93-4d02-9b65-ebf2df6563bd";
  // debugger
  let resultingIds = new Set();
  taskIds.forEach((assetId) => {
    if (store.eav.get(assetId)?.get(trashedAttrId)?.get(true)) {
      return;
    }
    resultingIds.add(assetId);
  });
  let idAttrId = "cb441f6f-226c-4c0d-a008-b924d65a9754";
  let idVecs = [];
  resultingIds.forEach((id) => {
    let time = store.eav.get(id)?.get(idAttrId)?.get(id)?.[3];
    idVecs.push([id, time]);
  });
  return transformIdVecs(store, etype, idVecs);
}

function customQueryForRole(store, etype, join) {
  const taskId = join[0];
  const refAttrId = join[1];
  const refTriples = store.eav.get(taskId)?.get(refAttrId)?.values();
  const asigneeIds = new Set(refTriples?.map((t) => t[2]));
  const trashedAttrId = "66769434-3d93-4d02-9b65-ebf2df6563bd";
  // debugger
  let resultingIds = new Set();
  asigneeIds.forEach((assetId) => {
    if (store.eav.get(assetId)?.get(trashedAttrId)?.get(true)) {
      return;
    }
    resultingIds.add(assetId);
  });
  let idAttrId = "70aec327-acaa-4c33-a918-5f62f58ca55e";
  let idVecs = [];
  resultingIds.forEach((id) => {
    let time = store.eav.get(id)?.get(idAttrId)?.get(id)?.[3];
    idVecs.push([id, time]);
  });
  return transformIdVecs(store, etype, idVecs);
}

function customQueryForProfile(store, etype, join) {
  const roleId = join[2];
  const refAttrId = join[1];
  const refTriples = store.vae.get(roleId)?.get(refAttrId)?.values();
  const asigneeIds = new Set(refTriples?.map((t) => t[0]));
  const trashedAttrId = "dd8bfbac-bb1e-4bd4-b218-3ac86b831ea5";
  // debugger
  let resultingIds = new Set();
  asigneeIds.forEach((assetId) => {
    if (store.eav.get(assetId)?.get(trashedAttrId)?.get(true)) {
      return;
    }
    resultingIds.add(assetId);
  });
  let idAttrId = "195b0dad-6422-4d83-8bf4-7bbf6b2abcc0";
  let idVecs = [];
  resultingIds.forEach((id) => {
    let time = store.eav.get(id)?.get(idAttrId)?.get(id)?.[3];
    idVecs.push([id, time]);
  });
  return transformIdVecs(store, etype, idVecs);
}

function customQueryForCategory(store, etype, dq) {
  const { where } = dq;
  const projectId = "0a9d191a-6ad3-4356-9277-3da13e40ffab";
  const refAttrId = where[0][1];
  const refTriples = store.eav.get(projectId)?.get(refAttrId)?.values();
  const categoryIds = new Set(refTriples?.map((t) => t[2]));
  const trashedAttrId = "b0b9be95-c61f-4663-a821-b7b4aa03e1d8";
  // debugger
  let resultingIds = new Set();
  categoryIds.forEach((assetId) => {
    if (store.eav.get(assetId)?.get(trashedAttrId)?.get(true)) {
      return;
    }
    resultingIds.add(assetId);
  });
  let idAttrId = "9dae508d-4c95-4822-9b23-9f81b49fe5ff";
  let idVecs = [];
  resultingIds.forEach((id) => {
    let time = store.eav.get(id)?.get(idAttrId)?.get(id)?.[3];
    idVecs.push([id, time]);
  });
  return transformIdVecs(store, etype, idVecs);
}

function runDatalogAndReturnObjects(store, etype, direction, pageInfo, dq) {
  if (isFind(dq.find, ["?category-0", "?time-0"])) {
    return customQueryForCategory(store, etype, dq);
  }
  throw new Error ('oi');
}

function determineOrder(form) {
  const orderOpts = form.$?.order;
  if (!orderOpts) {
    return "asc";
  }

  return orderOpts[Object.keys(orderOpts)[0]] || "asc";
}

/**
 * Given a query like:
 *
 * {
 *   users: {
 *     $: { where: { name: "Joe" } },
 *   },
 * };
 *
 * `resolveObjects`, turns where clause: `{ name: "Joe" }`
 * into a datalog query. We then run the datalog query,
 * and reduce all the triples into objects.
 */
function resolveObjects(store, { etype, level, form, join, pageInfo }) {
  const limit = form.$?.limit || form.$?.first || form.$?.last;
  const offset = form.$?.offset;
  const before = form.$?.before;
  const after = form.$?.after;

  // Wait for server to tell us where we start if we don't start from the beginning
  if ((offset || before || after) && (!pageInfo || !pageInfo["start-cursor"])) {
    return [];
  }

  const find = makeFind(makeVarImpl, etype, level);
  if (isFind(find, ["?role__task__assignee-3", "?time-3"])) {
    return customQueryForRole(store, etype, join);
  }
  if (isFind(find, ["?profile-4", "?time-4"])) {
    return customQueryForProfile(store, etype, join);
  }
  if (isFind(find, ["?task-2", "?time-2"])) {
    return customQueryForTask(store, etype, join);
  }
  if (isFind(find, ["?asset-1", "?time-1"])) {
    return customQueryForAsset(store, etype, join);
  }
  const where = withJoin(makeWhere(store, etype, level, form.$?.where), join);
  const objs = runDatalogAndReturnObjects(
    store,
    etype,
    determineOrder(form),
    pageInfo,
    { where, find },
  );

  if (limit != null) {
    const entries = Object.entries(objs);
    if (entries.length <= limit) {
      return objs;
    }
    return Object.fromEntries(entries.slice(0, limit));
  }
  return objs;
}

/**
 * It's possible that we query
 * for an attribute that doesn't exist yet.
 *
 * { users: { $: { where: { nonExistentProperty: "foo" } } } }
 *
 * This swallows the missing attr error and returns
 * an empty result instead
 */
function guardedResolveObjects(store, opts) {
  try {
    return resolveObjects(store, opts);
  } catch (e) {
    if (e instanceof AttrNotFoundError) {
      return {};
    }
    throw e;
  }
}
/**
 * Given a query like:
 *
 * {
 *   users: {
 *     $: { where: { name: "Joe" } },
 *     posts: {},
 *   },
 * };
 *
 * `guardResolveObjects` will return the relevant `users` objects
 * `extendObjects` will then extend each `user` object with relevant `posts`.
 */
function queryOne(store, opts) {
  const objects = guardedResolveObjects(store, opts);
  return extendObjects(makeVarImpl, store, opts, objects);
}

function formatPageInfo(pageInfo) {
  const res = {};
  for (const [k, v] of Object.entries(pageInfo)) {
    res[k] = {
      startCursor: v["start-cursor"],
      endCursor: v["end-cursor"],
      hasNextPage: v["has-next-page?"],
      hasPreviousPage: v["has-previous-page?"],
    };
  }
  return res;
}

export default function query({ store, pageInfo, aggregate }, q) {
  // const start = performance.now();
  console.profile("query");
  const data = Object.keys(q).reduce(function reduceResult(res, k) {
    if (aggregate?.[k]) {
      // Aggregate doesn't return any join rows and has no children,
      // so don't bother querying further
      return res;
    }
    res[k] = queryOne(store, {
      etype: k,
      form: q[k],
      level: 0,
      pageInfo: pageInfo?.[k],
    });
    return res;
  }, {});

  const result = { data };
  if (pageInfo) {
    result.pageInfo = formatPageInfo(pageInfo);
  }

  if (aggregate) {
    result.aggregate = aggregate;
  }
  console.profileEnd("query");
  // const end = performance.now();
  // console.log(
  //   "%cquery took " + (end - start) + " ms",
  //   "background: red; color: white",
  // );
  return result;
}
