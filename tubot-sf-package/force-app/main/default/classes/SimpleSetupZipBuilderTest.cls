@IsTest
private class SimpleSetupZipBuilderTest {
    @IsTest
    static void crc32MatchesKnownVector() {
        // CRC32('123456789') = 0xCBF43926.
        String hex = EncodingUtil.convertToHex(Blob.valueOf('123456789'));
        System.assertEquals(-873187034, SimpleSetupZipBuilder.crc32FromHex(hex));
    }

    @IsTest
    static void buildProducesValidStoredZip() {
        SimpleSetupZipBuilder zip = new SimpleSetupZipBuilder();
        zip.addFile('package.xml', '<Package/>');
        zip.addFile('queues/Q.queue-meta.xml', '<Queue/>');
        Blob archive = zip.build();
        String hex = EncodingUtil.convertToHex(archive).toUpperCase();
        // Local file header signature.
        System.assertEquals('504B0304', hex.substring(0, 8));
        // Both payloads embedded verbatim (stored, uncompressed).
        System.assert(hex.contains(
            EncodingUtil.convertToHex(Blob.valueOf('<Package/>')).toUpperCase()
        ));
        System.assert(hex.contains(
            EncodingUtil.convertToHex(Blob.valueOf('<Queue/>')).toUpperCase()
        ));
        // End-of-central-directory signature with 2 entries.
        System.assert(hex.contains('504B0506'));
        System.assert(hex.endsWith('0000'));
        String eocd = hex.substring(hex.length() - 44);
        // Entry counts (little-endian, 2 bytes each) equal 2.
        System.assertEquals('0200', eocd.substring(16, 20));
        System.assertEquals('0200', eocd.substring(20, 24));
    }

    @IsTest
    static void rejectsBlankPathOrNullContent() {
        Boolean rejectedPath = false;
        try {
            new SimpleSetupZipBuilder().addFile('', 'x');
        } catch (IllegalArgumentException expected) {
            rejectedPath = true;
        }
        System.assertEquals(true, rejectedPath);
        Boolean rejectedContent = false;
        try {
            new SimpleSetupZipBuilder().addFile('a.xml', null);
        } catch (IllegalArgumentException expected) {
            rejectedContent = true;
        }
        System.assertEquals(true, rejectedContent);
    }
}
