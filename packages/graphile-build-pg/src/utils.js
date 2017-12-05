// @flow
import sql from "pg-sql2";
import type { SQL } from "pg-sql2";
import upperFirstAll from "lodash/upperFirst";
import camelCaseAll from "lodash/camelCase";

export const sqlJsonBuildObjectFromFragments = (
  fragments: Array<{ sqlFragment: SQL, alias: Symbol | string }>
) => {
  return sql.fragment`
    json_build_object(
      ${sql.join(
        fragments.map(
          ({ sqlFragment, alias }) =>
            sql.fragment`${sql.literal(alias)}, ${sqlFragment}`
        ),
        ",\n"
      )}
    )`;
};

export const constantCaseAll = (str: string) =>
  str
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/[A-Z]+/g, "_$&")
    .replace(/__+/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .replace(/^[0-9]/, "_$&") // GraphQL enums must not start with a number
    .toUpperCase();

export const formatInsideUnderscores = (fn: (input: string) => string) => (
  str: string
) => {
  const matches = str.match(/^(_*)([\s\S]*?)(_*)$/);
  if (!matches) {
    throw new Error("Impossible?"); // Satiate Flow
  }
  const [, start, middle, end] = matches;
  return `${start}${fn(middle)}${end}`;
};

export const upperFirst = formatInsideUnderscores(upperFirstAll);
export const camelCase = formatInsideUnderscores(camelCaseAll);
export const constantCase = formatInsideUnderscores(constantCaseAll);
export const upperCamelCase = (str: string): string =>
  upperFirst(camelCase(str));

export const parseTags = (str: string) => {
  return str.split(`\n`).reduce((prev, curr) => {
    const match = curr.match(/^@[a-z]+ ?/);
    return match &&
    prev.text === "" &&
    curr.split(" ")[0] === match[0].split(" ")[0]
      ? Object.assign({}, prev, {
          tags: Object.assign({}, prev.tags, {
            [match[0].substr(1).trim()]:
              match[0] === curr ? true : curr.replace(match[0], ""),
          }),
        })
      : Object.assign({}, prev, {
          text: prev.text === "" ? curr : `${prev.text}\n${curr}`,
        });
  }, {
    tags: {},
    text: "",
  });
};
