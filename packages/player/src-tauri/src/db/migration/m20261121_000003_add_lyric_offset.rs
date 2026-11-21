use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_column("songs", "lyric_offset_ms").await? {
            manager
                .alter_table(
                    Table::alter()
                        .table(Songs::Table)
                        .add_column(
                            ColumnDef::new(Songs::LyricOffsetMs)
                                .integer()
                                .null()
                                .default(0),
                        )
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.has_column("songs", "lyric_offset_ms").await? {
            manager
                .alter_table(
                    Table::alter()
                        .table(Songs::Table)
                        .drop_column(Songs::LyricOffsetMs)
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Songs {
    Table,
    LyricOffsetMs,
}
