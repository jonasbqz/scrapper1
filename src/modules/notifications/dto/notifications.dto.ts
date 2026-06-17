import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsISO8601,
  Min,
  IsBoolean,
  IsArray,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class NotificationItemDto {
  @ApiProperty({ example: 42, description: 'Internal comic id' })
  @IsInt()
  comicId: number;

  @ApiProperty({ example: 'naruto' })
  @IsString()
  comicSlug: string;

  @ApiProperty({ example: 'Naruto' })
  @IsString()
  title: string;

  @ApiProperty({ example: 'https://cdn.example.com/naruto.jpg' })
  @IsUrl({ require_protocol: true })
  coverUrl: string;

  @ApiProperty({ example: 10, description: 'Last chapter the user read (0 if never read)' })
  @IsInt()
  @Min(0)
  lastChapterRead: number;

  @ApiProperty({ example: 15, description: 'Highest unread chapterNumber of the parent comic' })
  @IsInt()
  @Min(1)
  latestChapter: number;

  @ApiProperty({ example: 5, description: 'Number of unread chapters within the 30-day window' })
  @IsInt()
  @Min(0)
  newChaptersCount: number;

  @ApiProperty({
    example: '2025-06-15T00:00:00.000Z',
    description: 'release_date of the latest unread chapter (ISO 8601)',
  })
  @IsISO8601()
  latestChapterPublishedAt: string;

  @ApiProperty({
    example: 11,
    nullable: true,
    required: false,
    description:
      'Id of the next chapter the user should open (lowest chapterNumber, ties broken by lowest chapters.id). Null when newChaptersCount = 0.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  firstUnreadChapterId: number | null;
}

export class NotificationsResponseDto {
  @ApiProperty({ type: [NotificationItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => NotificationItemDto)
  items: NotificationItemDto[];

  @ApiProperty({ example: 1, description: 'items.length after truncation' })
  @IsInt()
  @Min(0)
  total: number;

  @ApiProperty({ example: false, description: 'true when more unread comics exist beyond 50' })
  @IsBoolean()
  hasMore: boolean;
}
