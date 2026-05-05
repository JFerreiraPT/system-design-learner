import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { z } from "zod";

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  transform(value: unknown, metadata: { metatype?: unknown }) {
    const metatype = metadata.metatype as { schema?: z.ZodTypeAny } | undefined;
    if (!metatype || !metatype.schema) {
      return value;
    }

    const result = metatype.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.flatten());
    }

    return result.data;
  }
}
