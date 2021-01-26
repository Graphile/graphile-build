import { SchemaBuilder, Options, Plugin, Context, Build } from "graphile-build";
import {
  GraphQLFieldResolver,
  GraphQLResolveInfo,
  GraphQLFieldConfig,
  GraphQLObjectType,
} from "graphql";
import {
  makeFieldHelpers,
  requireChildColumn,
  requireSiblingColumn,
} from "./fieldHelpers";

type ResolverWrapperFn<
  TSource = any,
  TContext = any,
  TArgs = { [argName: string]: any }
> = (
  resolve: GraphQLFieldResolver<TSource, TContext, TArgs>,
  source: TSource,
  args: TArgs,
  context: TContext,
  resolveInfo: GraphQLResolveInfo
) => any;
interface ResolverWrapperRequirements {
  childColumns?: Array<{ column: string; alias: string }>;
  siblingColumns?: Array<{ column: string; alias: string }>;
}

interface ResolverWrapperRule<
  TSource extends unknown = any,
  TContext extends unknown = any,
  TArgs extends unknown = { [argName: string]: any }
> {
  requires?: ResolverWrapperRequirements;
  resolve?: ResolverWrapperFn<TSource, TContext, TArgs>;
  // subscribe?: ResolverWrapperFn;
}

interface ResolverWrapperRules<
  TSource extends unknown = any,
  TContext extends unknown = any,
  TArgs extends unknown = { [argName: string]: any }
> {
  [typeName: string]: {
    [fieldName: string]:
      | ResolverWrapperRule<TSource, TContext, TArgs>
      | ResolverWrapperFn<TSource, TContext, TArgs>;
  };
}

type ResolverWrapperRulesGenerator<
  TSource extends unknown = any,
  TContext extends unknown = any,
  TArgs extends unknown = { [argName: string]: any }
> = (options: Options) => ResolverWrapperRules<TSource, TContext, TArgs>;

type ResolverWrapperFilter<T> = (
  context: Context<GraphQLObjectType>,
  build: Build,
  field: GraphQLFieldConfig<any, any>,
  options: Options
) => T | null;

type ResolverWrapperFilterRule<
  T,
  TSource extends unknown = any,
  TContext extends unknown = any,
  TArgs extends unknown = { [argName: string]: any }
> = (
  match: T
) =>
  | ResolverWrapperRule<TSource, TContext, TArgs>
  | ResolverWrapperFn<TSource, TContext, TArgs>;

export default function makeWrapResolversPlugin<
  TSource extends unknown = any,
  TContext extends unknown = any,
  TArgs extends unknown = { [argName: string]: any }
>(
  rulesOrGenerator:
    | ResolverWrapperRules<TSource, TContext, TArgs>
    | ResolverWrapperRulesGenerator<TSource, TContext, TArgs>
): Plugin;
export default function makeWrapResolversPlugin<
  T,
  TSource extends unknown = any,
  TContext extends unknown = any,
  TArgs extends unknown = { [argName: string]: any }
>(
  filter: ResolverWrapperFilter<T>,
  rule: ResolverWrapperFilterRule<T, TSource, TContext, TArgs>
): Plugin;
export default function makeWrapResolversPlugin<
  T,
  TSource extends unknown = any,
  TContext extends unknown = any,
  TArgs extends unknown = { [argName: string]: any }
>(
  rulesOrGeneratorOrFilter:
    | ResolverWrapperRules<TSource, TContext, TArgs>
    | ResolverWrapperRulesGenerator<TSource, TContext, TArgs>
    | ResolverWrapperFilter<T>,
  rule?: ResolverWrapperFilterRule<T>
): Plugin {
  if (rule && typeof rule !== "function") {
    throw new Error(
      "Invalid call signature for makeWrapResolversPlugin, expected second argument to be a function"
    );
  }
  return (builder: SchemaBuilder, options: Options) => {
    // Disambiguate first argument
    const rulesOrGenerator:
      | ResolverWrapperRules
      | ResolverWrapperRulesGenerator
      | null = rule ? null : (rulesOrGeneratorOrFilter as any);
    const filter: ResolverWrapperFilter<T> | null = rule
      ? (rulesOrGeneratorOrFilter as any)
      : null;

    const rules: ResolverWrapperRules | null =
      typeof rulesOrGenerator === "function"
        ? rulesOrGenerator(options)
        : rulesOrGenerator;
    builder.hook("GraphQLObjectType:fields:field", (field, build, context) => {
      const {
        Self,
        scope: { fieldName },
      } = context;
      let resolveWrapperOrSpec;
      if (filter) {
        const filterResult: any = filter(context, build, field, options);
        if (!filterResult) {
          if (filterResult !== null) {
            // eslint-disable-next-line no-console
            console.error(
              `Filter should return either a truthy value, or 'null', instead received: '${filterResult}'`
            );
          }
          return field;
        }
        resolveWrapperOrSpec = rule!(filterResult);
      } else if (rules) {
        const typeRules = rules[Self.name];
        if (!typeRules) {
          return field;
        }
        resolveWrapperOrSpec = typeRules[fieldName];
      } else {
        // Should not happen
        throw new Error(
          "Bad call signature for function makeWrapResolversPlugin"
        );
      }
      if (!resolveWrapperOrSpec) {
        return field;
      }
      const resolveWrapper: ResolverWrapperFn | undefined =
        typeof resolveWrapperOrSpec === "function"
          ? resolveWrapperOrSpec
          : resolveWrapperOrSpec.resolve;
      const resolveWrapperRequirements:
        | ResolverWrapperRequirements
        | undefined =
        typeof resolveWrapperOrSpec === "function"
          ? undefined
          : resolveWrapperOrSpec.requires;
      if (resolveWrapperRequirements) {
        // Perform requirements
        if (resolveWrapperRequirements.childColumns) {
          resolveWrapperRequirements.childColumns.forEach(
            ({ column, alias }) => {
              requireChildColumn(build, context, column, alias);
            }
          );
        }
        if (resolveWrapperRequirements.siblingColumns) {
          resolveWrapperRequirements.siblingColumns.forEach(
            ({ column, alias }) => {
              requireSiblingColumn(build, context, column, alias);
            }
          );
        }
      }
      if (!resolveWrapper) {
        return field;
      }
      const {
        resolve: oldResolve = (obj: Record<string, any>) => obj[fieldName],
      } = field;
      return {
        ...field,
        async resolve(...resolveParams) {
          const smartResolve = (...overrideParams: Array<any>) =>
            oldResolve(
              // @ts-ignore We're calling it dynamically, allowing the parent to override args.
              ...overrideParams.concat(
                resolveParams.slice(overrideParams.length)
              )
            );
          const [source, args, graphqlContext, resolveInfo] = resolveParams;
          const resolveInfoWithHelpers = {
            ...resolveInfo,
            graphile: makeFieldHelpers(
              build,
              context,
              graphqlContext,
              resolveInfo
            ),
          };
          return resolveWrapper(
            smartResolve,
            source,
            args,
            graphqlContext,
            resolveInfoWithHelpers
          );
        },
      };
    });
  };
}
