import { IsInt, IsOptional, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RecordReadingDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  comicId: number;

  @ApiProperty({ example: 1 })
  @IsInt()
  chapterId: number;

  @ApiPropertyOptional({ example: 50, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progressPercentage?: number;
}
