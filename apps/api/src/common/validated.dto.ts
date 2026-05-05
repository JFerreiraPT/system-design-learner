import { z } from "zod";

export class ValidatedDto<TSchema extends z.ZodTypeAny> {
  static schema: z.ZodTypeAny;
}
